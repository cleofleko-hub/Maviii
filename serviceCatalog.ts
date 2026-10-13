export const VIRTUAL_NUMBER_PRICE = 1;
export const VIRTUAL_NUMBER_MIN_PRICE = 0.51;
export const PROXY_PRICE = 1;

export const countryOffers = [
  { code: "US", name: "USA", flag: "🇺🇸", callingCode: "+1", region: "North America", format: "+1 ••• ••• ••••", price: 1 },
  { code: "GB", name: "UK", flag: "🇬🇧", callingCode: "+44", region: "Europe", format: "+44 •••• ••••••", price: 1 },
  { code: "CA", name: "Canada", flag: "🇨🇦", callingCode: "+1", region: "North America", format: "+1 ••• ••• ••••", price: 1 },
  { code: "AU", name: "Australia", flag: "🇦🇺", callingCode: "+61", region: "Oceania", format: "+61 ••• ••• •••", price: 1 },
  { code: "DE", name: "Germany", flag: "🇩🇪", callingCode: "+49", region: "Europe", format: "+49 ••• •••••••", price: 1 },
  { code: "FR", name: "France", flag: "🇫🇷", callingCode: "+33", region: "Europe", format: "+33 • •• •• •• ••", price: 0.51 },
] as const;

export function getVirtualNumberPrice(countryCode: CountryCode) {
  return countryOffers.find(country => country.code === countryCode)?.price ?? VIRTUAL_NUMBER_PRICE;
}

export const botTemplates = [
  {
    id: "support",
    name: "Support Desk",
    description: "Welcome messages, menu routing, FAQs, and human handoff controls.",
    label: "Customer care",
    features: ["Guided menu", "FAQ replies", "Agent handoff"],
  },
  {
    id: "sales",
    name: "Sales Assistant",
    description: "Qualify enquiries, share offers, collect leads, and route purchase intent.",
    label: "Lead conversion",
    features: ["Lead capture", "Offer flows", "Follow-up queue"],
  },
  {
    id: "alerts",
    name: "Smart Alerts",
    description: "Send structured opt-in updates and keep delivery activity visible.",
    label: "Notifications",
    features: ["Opt-in flows", "Delivery log", "Quiet hours"],
  },
] as const;

export const proxyTypes = [
  {
    id: "http",
    name: "HTTP",
    description: "Straightforward web routing for browser and API traffic.",
    latency: "≤ 65 ms",
    uptime: "99.9%",
    bestFor: "Browsing & APIs",
  },
  {
    id: "socks5",
    name: "SOCKS5",
    description: "Flexible routing for applications that need broader protocol support.",
    latency: "≤ 55 ms",
    uptime: "99.9%",
    bestFor: "Apps & automation",
  },
  {
    id: "residential",
    name: "Residential",
    description: "Region-aware routes designed for location-sensitive workflows.",
    latency: "≤ 120 ms",
    uptime: "99.5%",
    bestFor: "Regional access",
  },
  {
    id: "datacenter",
    name: "Datacenter",
    description: "High-throughput routing for speed-focused workloads.",
    latency: "≤ 35 ms",
    uptime: "99.9%",
    bestFor: "High-speed tasks",
  },
] as const;

export const proxyRegions = ["United States", "United Kingdom", "Canada", "Germany", "France", "Australia"] as const;

export type CountryCode = (typeof countryOffers)[number]["code"];
export type BotTemplateId = (typeof botTemplates)[number]["id"];
export type ProxyTypeId = (typeof proxyTypes)[number]["id"];
export type ProxyRegion = (typeof proxyRegions)[number];
