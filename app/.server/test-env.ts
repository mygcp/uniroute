import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-test-${randomUUID()}.db`;