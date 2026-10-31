// The connectors' ids, for checking requests from the dashboard. Kept apart
// from the connectors themselves (server code, with their API calls), so a
// module the browser also loads can use them; a test keeps the two in step.
export const CONNECTOR_IDS = ['shopify', 'stripe', 'calcom', 'custom_http'] as const

export type ConnectorId = (typeof CONNECTOR_IDS)[number]
