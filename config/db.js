const mongoose = require("mongoose");

let connectionPromise;

function getConnectionErrorMessage(error) {
  if (error?.name === "MongoParseError") {
    return "MONGODB_URI is malformed. Check that the host/port section contains only the Atlas hostname and that any credentials are separated from the host with @.";
  }

  if (
    error?.code === 18 ||
    error?.codeName === "AuthenticationFailed" ||
    /authentication failed/i.test(error?.message || "")
  ) {
    return "MongoDB authentication failed. Check the database username and password.";
  }

  if (
    error?.name === "MongoServerSelectionError" ||
    error?.name === "MongoNetworkError"
  ) {
    return "Could not reach MongoDB. Check the Atlas network access list, DNS, and connectivity.";
  }

  return "MongoDB connection failed. Check the connection string and Atlas configuration.";
}

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;

  if (!uri || !uri.trim()) {
    throw new Error("MONGODB_URI is required to start the backend.");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!connectionPromise) {
    const databaseName = process.env.MONGODB_DATABASE;
    connectionPromise = mongoose
      .connect(uri, databaseName ? { dbName: databaseName } : undefined)
      .then(() => {
        console.log("Connected to MongoDB.");
        return mongoose.connection;
      }, (error) => {
        connectionPromise = undefined;
        throw new Error(getConnectionErrorMessage(error));
      });
  }

  return connectionPromise;
}

module.exports = connectToDatabase;
