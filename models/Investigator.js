const mongoose = require("mongoose");

const investigatorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["admin", "investigator", "viewer"],
      required: true,
      default: "viewer",
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      required: true,
      default: "active",
    },
    sourceCodes: {
      type: [String],
      default: [],
      validate: {
        validator(sourceCodes) {
          return (
            sourceCodes.length <= 100 &&
            sourceCodes.every(
              (sourceCode) =>
                typeof sourceCode === "string" &&
                sourceCode.length > 0 &&
                sourceCode.length <= 80,
            ) &&
            new Set(sourceCodes).size === sourceCodes.length
          );
        },
        message: "sourceCodes must contain at most 100 unique source codes.",
      },
    },
  },
  { timestamps: true },
);

investigatorSchema.index({ email: 1 }, { unique: true });
investigatorSchema.index({ role: 1, status: 1 });

module.exports =
  mongoose.models.Investigator ||
  mongoose.model("Investigator", investigatorSchema);
