import { createHmac, timingSafeEqual } from "crypto";
import express, { type Express, type Request } from "express";
import { ENV } from "./_core/env";
import { processPaystackChargeSuccess, type PaystackChargeData } from "./paystack";

type PaystackWebhookEvent = {
  event?: string;
  data?: PaystackChargeData;
};

function hasValidSignature(rawBody: Buffer, signatureHeader: string | undefined) {
  if (!signatureHeader || !ENV.paystackSecretKey) return false;
  const expected = createHmac("sha512", ENV.paystackSecretKey).update(rawBody).digest("hex");
  const receivedBuffer = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function registerPaystackWebhook(app: Express) {
  app.post(
    "/api/paystack/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req: Request, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const signature = typeof req.headers["x-paystack-signature"] === "string" ? req.headers["x-paystack-signature"] : undefined;
      if (!hasValidSignature(rawBody, signature)) return res.status(401).json({ received: false });

      let event: PaystackWebhookEvent;
      try {
        event = JSON.parse(rawBody.toString("utf8")) as PaystackWebhookEvent;
      } catch {
        return res.status(400).json({ received: false });
      }

      if (event.event !== "charge.success" || !event.data) return res.status(200).json({ received: true });

      try {
        await processPaystackChargeSuccess(event.data);
        return res.status(200).json({ received: true });
      } catch (error) {
        console.error("[Paystack] Webhook fulfillment failed", error instanceof Error ? error.message : "Unknown error");
        return res.status(500).json({ received: false });
      }
    },
  );
}
