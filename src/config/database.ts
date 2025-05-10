import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/neon-http";

//load dnv vars
config({ path: '.env' });
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined');
}

//init neon client
const sql = neon(process.env.DATABASE_URL);


//init drizzle client
export const db = drizzle(sql);