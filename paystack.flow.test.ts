import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  createPaymentRecord: vi.fn(),
  markPaymentStatus: vi.fn(),
  getUserPaymentByReference: vi.fn(),
  fulfillVerifiedPayment: vi.fn(),
}));

vi.mock("./db", () => dbMocks);

import { calculatePaymentAmounts, initializePaystackPayment, verifyPaystackPayment } from "./paystack";

describe("Paystack payment flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes a server-side $1 proxy checkout with a unique reference", async () => {
    const quote = calculatePaymentAmounts("proxy");
    dbMocks.createPaymentRecord.mockResolvedValue({ id: 1, reference: "created" });
    dbMocks.markPaymentStatus.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/test-authorize",
          access_code: "access-code",
          reference: "provider-reference",
        },
      }),
    }));

    const result = await initializePaystackPayment({
      userId: 42,
      email: "user@example.com",
      name: "BOTPRESS User",
      serviceType: "proxy",
      itemCode: "datacenter",
      region: "Germany",
      callbackOrigin: "https://botpress.example",
    });

    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/test-authorize");
    expect(result.serviceValueCents).toBe(100);
    expect(result.settlementAmountSubunit).toBe(quote.settlementAmountSubunit);
    expect(result.reference).toMatch(/^BP-P-42-/);
    expect(dbMocks.createPaymentRecord).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      serviceType: "proxy",
      itemCode: "datacenter",
      region: "Germany",
      serviceValueCents: 100,
    }));
    expect(dbMocks.markPaymentStatus).toHaveBeenCalledWith(result.reference, "pending");
  });

  it("verifies the Paystack charge before requesting idempotent fulfillment", async () => {
    const quote = calculatePaymentAmounts("number", undefined, "US");
    dbMocks.getUserPaymentByReference.mockResolvedValue({
      id: 9,
      reference: "BP-N-42-reference",
      status: "pending",
      fulfilledAt: null,
    });
    dbMocks.fulfillVerifiedPayment.mockResolvedValue({ status: "paid", fulfilledAt: new Date() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: {
          id: 12345,
          status: "success",
          reference: "BP-N-42-reference",
          amount: quote.settlementAmountSubunit,
          currency: quote.currency,
        },
      }),
    }));

    const result = await verifyPaystackPayment(42, "BP-N-42-reference");

    expect(dbMocks.fulfillVerifiedPayment).toHaveBeenCalledWith("BP-N-42-reference", {
      providerTransactionId: "12345",
      amountSubunit: quote.settlementAmountSubunit,
      currency: quote.currency,
    });
    expect(result).toMatchObject({ status: "paid" });
  });

  it("maps an abandoned Paystack charge to the persisted cancelled-return state", async () => {
    dbMocks.getUserPaymentByReference
      .mockResolvedValueOnce({ id: 7, reference: "BP-P-42-abandoned", status: "pending", fulfilledAt: null })
      .mockResolvedValueOnce({ id: 7, reference: "BP-P-42-abandoned", status: "abandoned", fulfilledAt: null });
    dbMocks.markPaymentStatus.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: {
          id: 9876,
          status: "abandoned",
          reference: "BP-P-42-abandoned",
          amount: 0,
          currency: "KES",
          gateway_response: "Payment cancelled",
        },
      }),
    }));

    const result = await verifyPaystackPayment(42, "BP-P-42-abandoned");

    expect(dbMocks.markPaymentStatus).toHaveBeenCalledWith("BP-P-42-abandoned", "abandoned", "Payment cancelled");
    expect(dbMocks.fulfillVerifiedPayment).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "abandoned" });
  });
});
