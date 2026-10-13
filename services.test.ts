import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const dbMocks = vi.hoisted(() => ({
  getServiceDashboard: vi.fn(),
  purchaseVirtualNumber: vi.fn(),
  createBotDeployment: vi.fn(),
  updateBotDeployment: vi.fn(),
  createProxyActivation: vi.fn(),
  updateProxyActivation: vi.fn(),
  upsertUser: vi.fn(),
  getUserByOpenId: vi.fn(),
}));

vi.mock("./db", () => dbMocks);

import { appRouter } from "./routers";
import { countryOffers, PROXY_PRICE, proxyTypes, VIRTUAL_NUMBER_PRICE } from "../shared/serviceCatalog";
import { calculatePaymentAmounts } from "./paystack";

function createContext(authenticated = true): TrpcContext {
  return {
    user: authenticated
      ? {
          id: 42,
          openId: "botpress-user",
          email: "user@example.com",
          name: "BOTPRESS User",
          loginMethod: "manus",
          role: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: new Date(),
        }
      : null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("BOTPRESS service catalog", () => {
  it("keeps the required six countries and fixed number price", () => {
    expect(countryOffers.map(country => country.name)).toEqual([
      "USA",
      "UK",
      "Canada",
      "Australia",
      "Germany",
      "France",
    ]);
    expect(countryOffers.every(country => Boolean(country.flag))).toBe(true);
    expect(VIRTUAL_NUMBER_PRICE).toBe(1);
    expect(countryOffers.slice(0, 5).every(country => country.price === 1)).toBe(true);
    expect(countryOffers.at(-1)?.price).toBe(0.51);
  });

  it("exposes all four requested proxy types", () => {
    expect(proxyTypes.map(proxy => proxy.id)).toEqual(["http", "socks5", "residential", "datacenter"]);
    expect(PROXY_PRICE).toBe(1);
  });

  it("creates the expected payment values for fixed-price services", () => {
    const proxyQuote = calculatePaymentAmounts("proxy");
    const numberQuote = calculatePaymentAmounts("number", undefined, "US");
    const finalCountryQuote = calculatePaymentAmounts("number", undefined, "FR");

    expect(proxyQuote.serviceValueCents).toBe(100);
    expect(numberQuote.serviceValueCents).toBe(100);
    expect(finalCountryQuote.serviceValueCents).toBe(51);
    expect(proxyQuote.settlementAmountSubunit).toBeGreaterThan(0);
    expect(numberQuote.settlementAmountSubunit).toBe(proxyQuote.settlementAmountSubunit);
    expect(finalCountryQuote.settlementAmountSubunit).toBeLessThan(proxyQuote.settlementAmountSubunit);
  });
});

describe("authenticated service procedures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks dashboard data for unauthenticated callers", async () => {
    const caller = appRouter.createCaller(createContext(false));
    await expect(caller.dashboard.summary()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("passes the authenticated user ID into a number purchase", async () => {
    dbMocks.purchaseVirtualNumber.mockResolvedValue({ id: 7, countryName: "USA", priceCents: 100, status: "pending" });
    const caller = appRouter.createCaller(createContext());

    const result = await caller.numbers.purchase({ countryCode: "US" });

    expect(dbMocks.purchaseVirtualNumber).toHaveBeenCalledWith(42, "US");
    expect(result).toMatchObject({ countryName: "USA", priceCents: 100 });
  });

  it("returns an actionable error when wallet credit is insufficient", async () => {
    dbMocks.purchaseVirtualNumber.mockRejectedValue(new Error("INSUFFICIENT_BALANCE"));
    const caller = appRouter.createCaller(createContext());

    await expect(caller.numbers.purchase({ countryCode: "GB" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Your wallet does not have enough credit for this number.",
    });
  });

  it("creates bot and proxy configuration drafts for the current user", async () => {
    dbMocks.createBotDeployment.mockResolvedValue({ id: 10, name: "Support Desk" });
    dbMocks.createProxyActivation.mockResolvedValue({ id: 11, proxyType: "socks5", region: "Germany" });
    const caller = appRouter.createCaller(createContext());

    await caller.bots.create({ templateId: "support" });
    await caller.proxies.create({ proxyType: "socks5", region: "Germany" });

    expect(dbMocks.createBotDeployment).toHaveBeenCalledWith(42, "support");
    expect(dbMocks.createProxyActivation).toHaveBeenCalledWith(42, "socks5", "Germany");
  });
});
