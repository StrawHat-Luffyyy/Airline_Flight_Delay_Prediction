import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env.js';

let client: MongoClient | undefined;
let database: Db | undefined;

export async function connectToMongo(): Promise<void> {
  if (client) return;

  const nextClient = new MongoClient(env.MONGODB_URI);
  await nextClient.connect();
  client = nextClient;
  database = nextClient.db(env.MONGODB_DB);
}

export async function closeMongo(): Promise<void> {
  const currentClient = client;
  client = undefined;
  database = undefined;
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
