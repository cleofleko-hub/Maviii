import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "./db";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { calculatePaymentAmounts, initializePaystackPayment, verifyPaystackPayment } from "./paystack";

function toServiceError(error: unknown): never {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  if (message === "INSUFFICIENT_BALANCE") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your wallet does not have enough credit for this number." });
  }
  if (message.endsWith("_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "The requested service could not be found." });
  }
  if (message === "SESSION_REQUIRED") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a WhatsApp session before deploying this bot." });
  }
  if (message.endsWith("_NOT_SUPPORTED")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That service option is not supported." });
  }
  if (message === "DEPOSIT_AMOUNT_INVALID") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Deposit must start at $1." });
  }
  if (message.startsWith("PAYSTACK_") || message.startsWith("PAYMENT_")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The payment could not be completed safely. Please try again." });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The service action could not be completed." });
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  dashboard: router({
    summary: protectedProcedure.query(({ ctx }) => db.getServiceDashboard(ctx.user.id)),
  }),
  payments: router({
    quote: protectedProcedure
      .input(z.object({ serviceType: z.enum(["wallet", "number", "proxy"]), itemCode: z.string().max(64).optional(), depositDollars: z.number().min(1).max(10_000).optional() }))
      .query(({ input }) => calculatePaymentAmounts(input.serviceType, input.depositDollars, input.itemCode)),
    initialize: protectedProcedure
      .input(z.object({
        serviceType: z.enum(["wallet", "number", "proxy"]),
        itemCode: z.string().max(64).optional(),
        region: z.string().max(70).optional(),
        depositDollars: z.number().min(1).max(10_000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          if (!ctx.user.email) throw new Error("PAYMENT_EMAIL_REQUIRED");
          const forwardedProto = ctx.req.headers["x-forwarded-proto"];
          const forwardedHost = ctx.req.headers["x-forwarded-host"];
          const protocol = typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : ctx.req.protocol;
          const host = typeof forwardedHost === "string" ? forwardedHost.split(",")[0] : ctx.req.headers.host;
          if (!host) throw new Error("PAYMENT_ORIGIN_INVALID");
          return await initializePaystackPayment({
            userId: ctx.user.id,
            email: ctx.user.email,
            name: ctx.user.name,
            ...input,
            callbackOrigin: `${protocol}://${host}`,
          });
        } catch (error) {
          return toServiceError(error);
        }
      }),
    verify: protectedProcedure
      .input(z.object({ reference: z.string().min(8).max(96).regex(/^[A-Za-z0-9.=-]+$/) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await verifyPaystackPayment(ctx.user.id, input.reference);
        } catch (error) {
          return toServiceError(error);
        }
      }),
  }),
  numbers: router({
    purchase: protectedProcedure
      .input(z.object({ countryCode: z.enum(["US", "GB", "CA", "AU", "DE", "FR"]) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await db.purchaseVirtualNumber(ctx.user.id, input.countryCode);
        } catch (error) {
          return toServiceError(error);
        }
      }),
  }),
  bots: router({
    create: protectedProcedure
      .input(z.object({ templateId: z.enum(["support", "sales", "alerts"]) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await db.createBotDeployment(ctx.user.id, input.templateId);
        } catch (error) {
          return toServiceError(error);
        }
      }),
    action: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), action: z.enum(["connect", "deploy", "recover", "stop"]) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await db.updateBotDeployment(ctx.user.id, input.id, input.action);
        } catch (error) {
          return toServiceError(error);
        }
      }),
  }),
  proxies: router({
    create: protectedProcedure
      .input(z.object({
        proxyType: z.enum(["http", "socks5", "residential", "datacenter"]),
        region: z.enum(["United States", "United Kingdom", "Canada", "Germany", "France", "Australia"]),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await db.createProxyActivation(ctx.user.id, input.proxyType, input.region);
        } catch (error) {
          return toServiceError(error);
        }
      }),
    action: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), action: z.enum(["activate", "pause"]) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await db.updateProxyActivation(ctx.user.id, input.id, input.action);
        } catch (error) {
          return toServiceError(error);
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
