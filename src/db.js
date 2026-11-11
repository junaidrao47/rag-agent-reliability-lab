import { MongoClient } from "mongodb";
import { config } from "./config.js";

let client;

export async function getDb() {
  if (!client) {
    client = new MongoClient(config.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
  }
  // Database name comes from the connection string path.
  return client.db();
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = undefined;
  }
}
