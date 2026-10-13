import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  botDeployments,
  InsertUser,
  payments,
  proxyActivations,
  users,
  virtualNumbers,
  wallets,
  walletTransactions,
} from "../drizzle/schema";
import {
  botTemplates,
  countryOffers,
  proxyRegions,
  proxyTypes,
  getVirtualNumberPrice,
  type BotTemplateId,
  type CountryCode,
  type ProxyRegion,
  type ProxyTypeId,
} from "../shared/serviceCatalog";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

export async function ensureWallet(userId: number) {
  const db = await requireDb();
  await db
    .insert(wallets)
    .values({ userId, balanceCents: 0 })
    .onDuplicateKeyUpdate({ set: { userId } });

  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!wallet) throw new Error("WALLET_UNAVAILABLE");
  return wallet;
}

export async function getServiceDashboard(userId: number) {
  const db = await requireDb();
  const wallet = await ensureWallet(userId);
  const [transactions, numbers, bots, proxies, paymentHistory] = await Promise.all([
    db.select().from(walletTransactions).where(eq(walletTransactions.userId, userId)).orderBy(desc(walletTransactions.createdAt)).limit(8),
    db.select().from(virtualNumbers).where(eq(virtualNumbers.userId, userId)).orderBy(desc(virtualNumbers.createdAt)),
    db.select().from(botDeployments).where(eq(botDeployments.userId, userId)).orderBy(desc(botDeployments.createdAt)),
    db.select().from(proxyActivations).where(eq(proxyActivations.userId, userId)).orderBy(desc(proxyActivations.createdAt)),
    db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(12),
  ]);

  return { wallet, transactions, numbers, bots, proxies, payments: paymentHistory };
}

type CreatePaymentInput = {
  userId: number;
  reference: string;
  serviceType: "wallet" | "number" | "proxy";
  itemCode?: string;
  region?: string;
  serviceValueCents: number;
  settlementAmountSubunit: number;
  currency: string;
};

export async function createPaymentRecord(input: CreatePaymentInput) {
  const db = await requireDb();
  await db.insert(payments).values(input);
  const [payment] = await db.select().from(payments).where(eq(payments.reference, input.reference)).limit(1);
  if (!payment) throw new Error("PAYMENT_CREATE_FAILED");
  return payment;
}

export async function markPaymentStatus(
  reference: string,
  status: "pending" | "paid" | "failed" | "abandoned" | "refunded",
  failureReason?: string,
) {
  const db = await requireDb();
  await db
    .update(payments)
    .set({ status, failureReason: failureReason?.slice(0, 220) ?? null })
    .where(and(eq(payments.reference, reference), ne(payments.status, "paid")));
}

export async function getUserPaymentByReference(userId: number, reference: string) {
  const db = await requireDb();
  const [payment] = await db.select().from(payments).where(and(eq(payments.userId, userId), eq(payments.reference, reference))).limit(1);
  return payment;
}

type VerifiedPayment = {
  providerTransactionId: string;
  amountSubunit: number;
  currency: string;
};

export async function fulfillVerifiedPayment(reference: string, verified: VerifiedPayment) {
  const db = await requireDb();
  return db.transaction(async tx => {
    const [payment] = await tx.select().from(payments).where(eq(payments.reference, reference)).limit(1).for("update");
    if (!payment) throw new Error("PAYMENT_NOT_FOUND");
    if (payment.settlementAmountSubunit !== verified.amountSubunit || payment.currency !== verified.currency.toUpperCase()) {
      throw new Error("PAYMENT_AMOUNT_MISMATCH");
    }
    if (payment.fulfilledAt) return payment;

    let resourceId: number | null = null;
    if (payment.serviceType === "wallet") {
      await tx.insert(wallets).values({ userId: payment.userId, balanceCents: 0 }).onDuplicateKeyUpdate({ set: { userId: payment.userId } });
      await tx.update(wallets).set({ balanceCents: sql`${wallets.balanceCents} + ${payment.serviceValueCents}` }).where(eq(wallets.userId, payment.userId));
      const transaction = await tx.insert(walletTransactions).values({
        userId: payment.userId,
        type: "topup",
        status: "completed",
        amountCents: payment.serviceValueCents,
        description: "Paystack wallet deposit",
        serviceType: "wallet",
        externalPaymentId: reference,
      });
      resourceId = Number((transaction as unknown as [{ insertId?: number }])[0]?.insertId ?? 0);
    } else if (payment.serviceType === "number") {
      const offer = countryOffers.find(country => country.code === payment.itemCode);
      if (!offer) throw new Error("COUNTRY_NOT_SUPPORTED");
      const created = await tx.insert(virtualNumbers).values({
        userId: payment.userId,
        countryCode: offer.code,
        countryName: offer.name,
        priceCents: payment.serviceValueCents,
        status: "pending",
      });
      resourceId = Number((created as unknown as [{ insertId?: number }])[0]?.insertId ?? 0);
    } else {
      if (!proxyTypes.some(proxy => proxy.id === payment.itemCode)) throw new Error("PROXY_TYPE_NOT_SUPPORTED");
      if (!proxyRegions.includes(payment.region as ProxyRegion)) throw new Error("PROXY_REGION_NOT_SUPPORTED");
      const created = await tx.insert(proxyActivations).values({
        userId: payment.userId,
        proxyType: payment.itemCode!,
        region: payment.region!,
        status: "setup_required",
      });
      resourceId = Number((created as unknown as [{ insertId?: number }])[0]?.insertId ?? 0);
    }

    const fulfilledAt = new Date();
    await tx.update(payments).set({
      status: "paid",
      providerTransactionId: verified.providerTransactionId.slice(0, 32),
      resourceId,
      paidAt: fulfilledAt,
      fulfilledAt,
      failureReason: null,
    }).where(eq(payments.id, payment.id));

    const [fulfilled] = await tx.select().from(payments).where(eq(payments.id, payment.id)).limit(1);
    if (!fulfilled) throw new Error("PAYMENT_FULFILLMENT_FAILED");
    return fulfilled;
  });
}

export async function purchaseVirtualNumber(userId: number, countryCode: CountryCode) {
  const db = await requireDb();
  const offer = countryOffers.find(country => country.code === countryCode);
  if (!offer) throw new Error("COUNTRY_NOT_SUPPORTED");
  const priceCents = Math.round(getVirtualNumberPrice(offer.code) * 100);

  return db.transaction(async tx => {
    await tx
      .insert(wallets)
      .values({ userId, balanceCents: 0 })
      .onDuplicateKeyUpdate({ set: { userId } });

    const debitResult = await tx
      .update(wallets)
      .set({ balanceCents: sql`${wallets.balanceCents} - ${priceCents}` })
      .where(and(eq(wallets.userId, userId), gte(wallets.balanceCents, priceCents)));

    const affectedRows = Number((debitResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    if (affectedRows !== 1) throw new Error("INSUFFICIENT_BALANCE");

    const inserted = await tx.insert(virtualNumbers).values({
      userId,
      countryCode: offer.code,
      countryName: offer.name,
      priceCents,
      status: "pending",
    });

    await tx.insert(walletTransactions).values({
      userId,
      type: "purchase",
      status: "completed",
      amountCents: -priceCents,
      description: `${offer.name} virtual WhatsApp number`,
      serviceType: "number",
    });

    return {
      id: Number((inserted as unknown as [{ insertId?: number }])[0]?.insertId ?? 0),
      countryName: offer.name,
      priceCents,
      status: "pending" as const,
    };
  });
}

export async function createBotDeployment(userId: number, templateId: BotTemplateId) {
  const db = await requireDb();
  const template = botTemplates.find(item => item.id === templateId);
  if (!template) throw new Error("BOT_TEMPLATE_NOT_SUPPORTED");

  const inserted = await db.insert(botDeployments).values({
    userId,
    templateId: template.id,
    name: template.name,
    status: "setup_required",
    sessionStatus: "unlinked",
  });

  return { id: Number((inserted as unknown as [{ insertId?: number }])[0]?.insertId ?? 0), name: template.name };
}

export async function updateBotDeployment(userId: number, id: number, action: "connect" | "deploy" | "recover" | "stop") {
  const db = await requireDb();
  const [bot] = await db.select().from(botDeployments).where(and(eq(botDeployments.id, id), eq(botDeployments.userId, userId))).limit(1);
  if (!bot) throw new Error("BOT_NOT_FOUND");

  if (action === "connect") {
    await db.update(botDeployments).set({ sessionStatus: "connected", status: "setup_required" }).where(eq(botDeployments.id, id));
  } else if (action === "deploy") {
    if (bot.sessionStatus !== "connected") throw new Error("SESSION_REQUIRED");
    await db.update(botDeployments).set({ status: "online" }).where(eq(botDeployments.id, id));
  } else if (action === "recover") {
    await db.update(botDeployments).set({ status: "recovery" }).where(eq(botDeployments.id, id));
  } else {
    await db.update(botDeployments).set({ status: "offline" }).where(eq(botDeployments.id, id));
  }

  return { success: true as const };
}

export async function createProxyActivation(userId: number, proxyType: ProxyTypeId, region: ProxyRegion) {
  const db = await requireDb();
  if (!proxyTypes.some(proxy => proxy.id === proxyType)) throw new Error("PROXY_TYPE_NOT_SUPPORTED");
  if (!proxyRegions.includes(region)) throw new Error("PROXY_REGION_NOT_SUPPORTED");

  const inserted = await db.insert(proxyActivations).values({ userId, proxyType, region, status: "setup_required" });
  return { id: Number((inserted as unknown as [{ insertId?: number }])[0]?.insertId ?? 0), proxyType, region };
}

export async function updateProxyActivation(userId: number, id: number, action: "activate" | "pause") {
  const db = await requireDb();
  const [proxy] = await db.select().from(proxyActivations).where(and(eq(proxyActivations.id, id), eq(proxyActivations.userId, userId))).limit(1);
  if (!proxy) throw new Error("PROXY_NOT_FOUND");
  await db.update(proxyActivations).set({ status: action === "activate" ? "active" : "paused" }).where(eq(proxyActivations.id, id));
  return { success: true as const };
}
