// How the marketing screen decides it has live campaign data.
// A missing source is not a campaign, and it is not a spend of zero.

export const MARKETING_NOT_CONNECTED = 'Not connected / no live campaign data'

export interface MarketingConnection {
  connected?: boolean
  linkedin?: unknown
  blog?: unknown
  canva?: unknown
  optimization?: unknown
  schedule?: unknown
}

export function liveCampaign(data: MarketingConnection | null): boolean {
  return data?.connected === true
    && data.linkedin != null
    && data.blog != null
    && data.canva != null
    && data.optimization != null
    && data.schedule != null
}
