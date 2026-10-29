const formatterCache = new Map();

function getFormatter(timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function getLocalParts(date, timezone) {
  const parts = Object.fromEntries(
    getFormatter(timezone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function localDateTimeToUtc(parts, timezone) {
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
  );
  let candidate = targetAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = getLocalParts(new Date(candidate), timezone);
    const localAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    candidate = targetAsUtc - (localAsUtc - candidate);
  }

  const result = new Date(candidate);
  const actual = getLocalParts(result, timezone);
  if (
    actual.year !== parts.year ||
    actual.month !== parts.month ||
    actual.day !== parts.day ||
    actual.hour !== parts.hour ||
    actual.minute !== parts.minute
  ) {
    throw new RangeError(
      `The scheduled local time does not exist in timezone ${timezone}.`,
    );
  }

  return result;
}

function addCalendarDays(date, days) {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function getReportingPeriod(schedule, now) {
  const timezone = schedule.timezone;
  const localNow = getLocalParts(now, timezone);
  const localDate = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
  const reportingTime = schedule.reportingTime;
  let startDate;
  let endDate;
  let deadlineDate;

  if (schedule.frequency === "daily") {
    startDate = localDate;
    endDate = addCalendarDays(localDate, 1);
    deadlineDate = reportingTime ? localDate : endDate;
  } else {
    const weekday = new Date(
      Date.UTC(localDate.year, localDate.month - 1, localDate.day),
    ).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    startDate = addCalendarDays(localDate, -daysSinceMonday);
    endDate = addCalendarDays(startDate, 7);
    deadlineDate = reportingTime
      ? addCalendarDays(startDate, 6)
      : endDate;
  }

  const start = localDateTimeToUtc(
    { ...startDate, hour: 0, minute: 0 },
    timezone,
  );
  const end = localDateTimeToUtc(
    { ...endDate, hour: 0, minute: 0 },
    timezone,
  );
  const deadlineParts = reportingTime
    ? reportingTime.split(":").map(Number)
    : [0, 0];
  const deadline = localDateTimeToUtc(
    {
      ...deadlineDate,
      hour: deadlineParts[0],
      minute: deadlineParts[1],
    },
    timezone,
  );

  return { start, end, deadline, timezone };
}

function asDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid date.`);
  }
  return date;
}

function asIdentifier(value) {
  return value == null ? null : String(value);
}

function normalizeTrustedIds(trustedReportIds) {
  if (trustedReportIds == null) return new Set();
  if (
    !(trustedReportIds instanceof Set) &&
    !Array.isArray(trustedReportIds)
  ) {
    throw new TypeError("trustedReportIds must be a Set or an array.");
  }
  return new Set(
    [...trustedReportIds]
      .map(asIdentifier)
      .filter((identifier) => identifier !== null),
  );
}

function validateSource(source) {
  if (!source || typeof source !== "object" || !source.sourceCode) {
    throw new TypeError("Every reporting source must have a sourceCode.");
  }

  const schedule = source.reportingSchedule;
  if (
    !schedule ||
    !["daily", "weekly"].includes(schedule.frequency) ||
    !Number.isInteger(schedule.expectedReportsPerPeriod) ||
    schedule.expectedReportsPerPeriod <= 0 ||
    typeof schedule.timezone !== "string"
  ) {
    throw new TypeError(
      `Reporting source ${source.sourceCode} has an invalid schedule.`,
    );
  }

  if (
    schedule.reportingTime !== undefined &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.reportingTime)
  ) {
    throw new TypeError(
      `Reporting source ${source.sourceCode} has an invalid reportingTime.`,
    );
  }

  try {
    getFormatter(schedule.timezone);
  } catch {
    throw new TypeError(
      `Reporting source ${source.sourceCode} has an invalid timezone.`,
    );
  }

  return {
    validFrom: asDate(source.validFrom, "validFrom"),
    validUntil:
      source.validUntil == null
        ? null
        : asDate(source.validUntil, "validUntil"),
  };
}

function validateReports(reports) {
  if (!Array.isArray(reports)) {
    throw new TypeError("reports must be an array.");
  }
}

function calculateReportingCompleteness({
  sources,
  reports,
  now = new Date(),
  trustedReportIds,
  channelAvailabilityBySourceCode = {},
}) {
  if (!Array.isArray(sources)) {
    throw new TypeError("sources must be an array.");
  }
  validateReports(reports);

  const evaluatedAt = asDate(now, "now");
  // sourceId is client-controlled; callers must separately attest trusted report IDs.
  const trustedIds = normalizeTrustedIds(trustedReportIds);
  const sourceCodes = new Set();

  return sources.map((source) => {
    const { validFrom, validUntil } = validateSource(source);
    if (validUntil && validUntil < validFrom) {
      throw new TypeError(
        `Reporting source ${source.sourceCode} has an invalid validity range.`,
      );
    }
    const sourceCode = String(source.sourceCode);
    if (sourceCodes.has(sourceCode)) {
      throw new TypeError(`Duplicate reporting source code: ${sourceCode}.`);
    }
    sourceCodes.add(sourceCode);

    const period = getReportingPeriod(source.reportingSchedule, evaluatedAt);
    const base = {
      sourceCode,
      period,
      expectedReports: source.reportingSchedule.expectedReportsPerPeriod,
      receivedReports: null,
      completenessPercent: null,
      channelAvailability:
        channelAvailabilityBySourceCode[sourceCode] || "unknown",
    };

    if (!["unknown", "available", "unavailable"].includes(base.channelAvailability)) {
      throw new TypeError(
        `Invalid channel availability for reporting source ${sourceCode}.`,
      );
    }

    if (source.isActive === false) {
      return { ...base, status: "inactive" };
    }

    if (
      validFrom > period.start ||
      (validUntil && validUntil < period.deadline)
    ) {
      return { ...base, status: "not_applicable" };
    }

    const isCompletePeriod = evaluatedAt >= period.deadline;
    const matchingReports = reports.filter((report) => {
      const reportId = asIdentifier(report?._id ?? report?.id);
      if (!reportId || !trustedIds.has(reportId)) return false;
      if (String(report.sourceId || "") !== sourceCode) return false;

      const submittedAtValue = report.submittedAt ?? report.createdAt;
      if (submittedAtValue == null) return false;
      const submittedAt = new Date(submittedAtValue);
      if (Number.isNaN(submittedAt.getTime())) return false;

      return (
        submittedAt >= period.start &&
        submittedAt < period.end &&
        submittedAt <= evaluatedAt
      );
    });
    const receivedReports = matchingReports.length;

    if (!isCompletePeriod) {
      return {
        ...base,
        receivedReports,
        status: "in_progress",
      };
    }

    const completenessPercent = Math.min(
      100,
      (receivedReports / source.reportingSchedule.expectedReportsPerPeriod) *
        100,
    );
    let status;
    if (receivedReports >= source.reportingSchedule.expectedReportsPerPeriod) {
      status = "complete";
    } else if (
      receivedReports === 0 &&
      base.channelAvailability === "unavailable"
    ) {
      status = "channel_unavailable";
    } else if (receivedReports === 0) {
      status = "reporting_gap";
    } else if (base.channelAvailability === "unavailable") {
      status = "incomplete_channel_unavailable";
    } else {
      status = "incomplete";
    }

    return {
      ...base,
      receivedReports,
      completenessPercent,
      status,
    };
  });
}

module.exports = calculateReportingCompleteness;
