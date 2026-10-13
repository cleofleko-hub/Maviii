import { describe, expect, it } from "vitest";

describe("Paystack credentials", () => {
  it("authenticates the configured secret key against Paystack", async () => {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    expect(secretKey, "PAYSTACK_SECRET_KEY must be configured").toBeTruthy();
    expect(secretKey).toMatch(/^sk_(test|live)_/);

    const response = await fetch("https://api.paystack.co/transaction/totals", {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      },
    });

    expect(response.status, "Paystack should accept the configured secret key").toBe(200);
    const body = (await response.json()) as { status?: boolean };
    expect(body.status).toBe(true);
  }, 15_000);

  it("has a supported settlement currency and positive one-dollar value", () => {
    expect(["KES", "NGN", "GHS", "ZAR"]).toContain(process.env.PAYSTACK_CURRENCY);
    const oneDollarAmount = Number(process.env.PAYSTACK_ONE_DOLLAR_AMOUNT);
    expect(Number.isFinite(oneDollarAmount)).toBe(true);
    expect(oneDollarAmount).toBeGreaterThan(0);
  });
});
