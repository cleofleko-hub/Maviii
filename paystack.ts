import { randomBytes } from "crypto";
import {
  countryOffers,
  PROXY_PRICE,
  proxyRegions,
  proxyTypes,
  getVirtualNumberPrice,
  type CountryCode,
  type ProxyRegion,
  type ProxyTypeId,
} from "../shared/serviceCatalog";
import { ENV } from "./_core/env";
import * as db from "./db";

export type PaymentServiceType = "wallet" | "number" | "proxy";

type InitializePaymentInput = {
  userId: number;
  email: string;
  name?: string | null;
  serviceType: PaymentServiceType;
  itemCode?: string;
  region?: string;
  depositDollars?: number;
  callbackOrigin: string;
};

type PaystackInitializeResponse = {
  status: boolean;
  message: string;
  data?: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
};

type PaystackVerifyResponse = {
  status: boolean;
  message: string;
  data?: {
    id: number | string;
    status: string;
    reference: string;
    amount: number;
    currency: string;
    paid_at?: string | null;
    gateway_response?: string | null;
  };
};

export type PaystackChargeData = NonNullable<PaystackVerifyResponse["data"]>;

export function getPaystackConfig() {
  const secretKey = ENV.paystackSecretKey;
  const currency = ENV.paystackCurrency.trim().toUpperCase();
  const oneDollarMajor = Number(ENV.paystackOneDollarAmount);

  if (!/^sk_(test|live)_/.test(secretKey)) throw new Error("PAYSTACK_NOT_CONFIGURED");
  if (!["KES", "NGN", "GHS", "ZAR"].includes(currency)) throw new Error("PAYSTACK_CURRENCY_INVALID");
  if (!Number.isFinite(oneDollarMajor) || oneDollarMajor <= 0) throw new Error("PAYSTACK_RATE_INVALID");

  return {
    secretKey,
    currency,
    oneDollarMajor,
    oneDollarSubunit: Math.round(oneDollarMajor * 100),
  };
}

export function calculatePaymentAmounts(serviceType: PaymentServiceType, depositDollars?: number, itemCode?: string) {
  const { oneDollarSubunit, currency } = getPaystackConfig();
  let serviceValueCents: number;

  if (serviceType === "wallet") {
    if (!Number.isFinite(depositDollars) || (depositDollars ?? 0) < 1 || (depositDollars ?? 0) > 10_000) {
      throw new Error("DEPOSIT_AMOUNT_INVALID");
    }
    serviceValueCents = Math.round((depositDollars ?? 0) * 100);
  } else if (serviceType === "number") {
    const offer = countryOffers.find(country => country.code === itemCode);
    if (!offer) throw new Error("COUNTRY_NOT_SUPPORTED");
    serviceValueCents = Math.round(getVirtualNumberPrice(offer.code) * 100);
  } else {
    serviceValueCents = Math.round(PROXY_PRICE * 100);
  }

  return {
    serviceValueCents,
    settlementAmountSubunit: Math.round((oneDollarSubunit * serviceValueCents) / 100),
    currency,
  };
}

function validateServiceSelection(serviceType: PaymentServiceType, itemCode?: string, region?: string) {
  if (serviceType === "wallet") return;
  if (serviceType === "number") {
    if (!countryOffers.some(country => country.code === itemCode)) throw new Error("COUNTRY_NOT_SUPPORTED");
    return;
  }
  if (!proxyTypes.some(proxy => proxy.id === itemCode)) throw new Error("PROXY_TYPE_NOT_SUPPORTED");
  if (!proxyRegions.includes(region as ProxyRegion)) throw new Error("PROXY_REGION_NOT_SUPPORTED");
}

function createReference(serviceType: PaymentServiceType, userId: number) {
  const serviceCode = serviceType === "wallet" ? "W" : serviceType === "number" ? "N" : "P";
  return `BP-${serviceCode}-${userId}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function isPaystackCheckoutUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "checkout.paystack.com";
  } catch {
    return false;
  }
}

export async function initializePaystackPayment(input: InitializePaymentInput) {
  validateServiceSelection(input.serviceType, input.itemCode, input.region);
  const config = getPaystackConfig();
  const amounts = calculatePaymentAmounts(input.serviceType, input.depositDollars, input.itemCode);
  const reference = createReference(input.serviceType, input.userId);
  const callbackUrl = `${input.callbackOrigin.replace(/\/$/, "")}/payment/return`;

  await db.createPaymentRecord({
    userId: input.userId,
    reference,
    serviceType: input.serviceType,
    itemCode: input.itemCode,
    region: input.region,
    ...amounts,
  });

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        amount: amounts.settlementAmountSubunit,
        currency: amounts.currency,
        reference,
        callback_url: callbackUrl,
        metadata: JSON.stringify({
          user_id: input.userId,
          customer_name: input.name || undefined,
          service_type: input.serviceType,
          item_code: input.itemCode,
          region: input.region,
          service_value_cents: amounts.serviceValueCents,
        }),
      }),
    });

    const body = (await response.json()) as PaystackInitializeResponse;
    const authorizationUrl = body.data?.authorization_url;
    if (!response.ok || !body.status || !authorizationUrl || !isPaystackCheckoutUrl(authorizationUrl)) {
      await db.markPaymentStatus(reference, "failed", body.message || "Paystack initialization failed");
      throw new Error("PAYSTACK_INITIALIZATION_FAILED");
    }

    await db.markPaymentStatus(reference, "pending");
    return {
      authorizationUrl,
      reference,
      serviceType: input.serviceType,
      serviceValueCents: amounts.serviceValueCents,
      settlementAmountSubunit: amounts.settlementAmountSubunit,
      currency: amounts.currency,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "PAYSTACK_INITIALIZATION_FAILED") throw error;
    await db.markPaymentStatus(reference, "failed", "Unable to contact Paystack");
    throw new Error("PAYSTACK_UNAVAILABLE");
  }
}

export async function verifyPaystackPayment(userId: number, reference: string) {
  const localPayment = await db.getUserPaymentByReference(userId, reference);
  if (!localPayment) throw new Error("PAYMENT_NOT_FOUND");
  if (localPayment.status === "paid" && localPayment.fulfilledAt) return localPayment;

  const config = getPaystackConfig();
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${config.secretKey}`, Accept: "application/json" },
  });
  const body = (await response.json()) as PaystackVerifyResponse;
  if (!response.ok || !body.status || !body.data) throw new Error("PAYSTACK_VERIFICATION_FAILED");

  if (body.data.status === "success") {
    return db.fulfillVerifiedPayment(reference, {
      providerTransactionId: String(body.data.id),
      amountSubunit: body.data.amount,
      currency: body.data.currency,
    });
  }

  const status = body.data.status === "abandoned" ? "abandoned" : body.data.status === "failed" ? "failed" : "pending";
  await db.markPaymentStatus(reference, status, body.data.gateway_response || undefined);
  return db.getUserPaymentByReference(userId, reference);
}

export async function processPaystackChargeSuccess(data: PaystackChargeData) {
  if (data.status !== "success") return null;
  return db.fulfillVerifiedPayment(data.reference, {
    providerTransactionId: String(data.id),
    amountSubunit: data.amount,
    currency: data.currency,
  });
}

export type PaystackServiceItem = CountryCode | ProxyTypeId;
