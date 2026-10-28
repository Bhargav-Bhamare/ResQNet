const mongoose = require("mongoose");

let connectionPromise;

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;

  if (!uri || !uri.trim()) {
    throw new Error("MONGODB_URI is required to start the backend.");
  }

  try {
    const parsedUri = new URL(uri);
    if (
      !["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol) ||
      !parsedUri.hostname
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("MONGODB_URI is not a valid MongoDB connection string.");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(uri)
      .then(() => {
        console.log("Connected to MongoDB.");
        return mongoose.connection;
      })
      .catch(() => {
        connectionPromise = undefined;
        throw new Error(
          "MongoDB connection failed. Check the URI, credentials, and Atlas network access settings.",
        );
      });
  }

  return connectionPromise;
}

module.exports = connectToDatabase;
