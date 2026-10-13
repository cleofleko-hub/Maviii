import { index, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const wallets = mysqlTable(
  "wallets",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    balanceCents: int("balanceCents").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("wallets_user_id_unique").on(table.userId)],
);

export const walletTransactions = mysqlTable(
  "walletTransactions",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: mysqlEnum("type", ["topup", "purchase", "refund"]).notNull(),
    status: mysqlEnum("status", ["pending", "completed", "failed"]).default("pending").notNull(),
    amountCents: int("amountCents").notNull(),
    description: varchar("description", { length: 220 }).notNull(),
    serviceType: mysqlEnum("serviceType", ["wallet", "number", "bot", "proxy"]).default("wallet").notNull(),
    externalPaymentId: varchar("externalPaymentId", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("wallet_transactions_user_created_idx").on(table.userId, table.createdAt)],
);

export const payments = mysqlTable(
  "payments",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 96 }).notNull(),
    providerTransactionId: varchar("providerTransactionId", { length: 32 }),
    serviceType: mysqlEnum("serviceType", ["wallet", "number", "proxy"]).notNull(),
    itemCode: varchar("itemCode", { length: 64 }),
    region: varchar("region", { length: 70 }),
    serviceValueCents: int("serviceValueCents").notNull(),
    settlementAmountSubunit: int("settlementAmountSubunit").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: mysqlEnum("status", ["initialized", "pending", "paid", "failed", "abandoned", "refunded"]).default("initialized").notNull(),
    failureReason: varchar("failureReason", { length: 220 }),
    resourceId: int("resourceId"),
    paidAt: timestamp("paidAt"),
    fulfilledAt: timestamp("fulfilledAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("payments_reference_unique").on(table.reference),
    index("payments_user_created_idx").on(table.userId, table.createdAt),
    index("payments_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const virtualNumbers = mysqlTable(
  "virtualNumbers",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    countryCode: varchar("countryCode", { length: 2 }).notNull(),
    countryName: varchar("countryName", { length: 60 }).notNull(),
    displayNumber: varchar("displayNumber", { length: 40 }),
    priceCents: int("priceCents").default(160).notNull(),
    status: mysqlEnum("status", ["pending", "active", "expired", "failed"]).default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("virtual_numbers_user_status_idx").on(table.userId, table.status)],
);

export const botDeployments = mysqlTable(
  "botDeployments",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    templateId: varchar("templateId", { length: 32 }).notNull(),
    name: varchar("name", { length: 90 }).notNull(),
    status: mysqlEnum("status", ["setup_required", "deploying", "online", "offline", "recovery"]).default("setup_required").notNull(),
    sessionStatus: mysqlEnum("sessionStatus", ["unlinked", "connected", "expired"]).default("unlinked").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("bot_deployments_user_status_idx").on(table.userId, table.status)],
);

export const proxyActivations = mysqlTable(
  "proxyActivations",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    proxyType: varchar("proxyType", { length: 32 }).notNull(),
    region: varchar("region", { length: 70 }).notNull(),
    status: mysqlEnum("status", ["setup_required", "active", "paused", "expired"]).default("setup_required").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("proxy_activations_user_status_idx").on(table.userId, table.status)],
);

export type Wallet = typeof wallets.$inferSelect;
export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type VirtualNumber = typeof virtualNumbers.$inferSelect;
export type BotDeployment = typeof botDeployments.$inferSelect;
export type ProxyActivation = typeof proxyActivations.$inferSelect;
