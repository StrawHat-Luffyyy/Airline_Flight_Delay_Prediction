import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env.js';

let client: MongoClient | undefined;
let database: Db | undefined;
let connecting: Promise<void> | undefined;

export function connectToMongo(): Promise<void> {
  if (client) return Promise.resolve();
  // Cache the in-flight connect so concurrent callers share one client.
  connecting ??= (async () => {
    const nextClient = new MongoClient(env.MONGODB_URI);
    try {
      await nextClient.connect();
    } catch (error) {
      connecting = undefined;
      await nextClient.close();
      throw error;
    }
    client = nextClient;
    database = nextClient.db(env.MONGODB_DB);
  })();
  return connecting;
}

export async function closeMongo(): Promise<void> {
  const currentClient = client;
  client = undefined;
  database = undefined;
  connecting = undefined;
  await currentClient?.close();
}

export function getDb(): Db {
  if (!database) throw new Error('MongoDB is not connected');
  return database;
}

export async function pingMongo(): Promise<boolean> {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
