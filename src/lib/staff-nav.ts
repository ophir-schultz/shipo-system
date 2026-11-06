// Staff navigation. Four groups, with Settings kept out of that row.
// Routes stay where they are. This file only decides how they are grouped.

export interface StaffNavItem {
  href: string
  label: string
}

export interface StaffNavGroup {
  id: 'overview' | 'orders' | 'financials' | 'reports'
  label: 'Overview' | 'Orders' | 'Financials' | 'Reports'
  items: readonly StaffNavItem[]
}

export const STAFF_NAV: readonly StaffNavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/data-issues', label: 'Data issues' },
      { href: '/losses', label: 'Loss analysis' },
    ],
  },
  {
    id: 'orders',
    label: 'Orders',
    items: [
      { href: '/clients', label: 'Clients' },
      { href: '/shipments', label: 'Shipments' },
      { href: '/warehouse', label: 'Warehouse log' },
      { href: '/scan', label: 'Serialization scan' },
      { href: '/serials', label: 'Serial history' },
    ],
  },
  {
    id: 'financials',
    label: 'Financials',
    items: [
      { href: '/billing', label: 'Billing' },
      { href: '/statements', label: 'Statements' },
      { href: '/order-pnl', label: 'Order P&L' },
      { href: '/profit', label: 'Profit' },
      { href: '/pnl', label: 'Campaigns + P&L' },
      { href: '/ledger', label: 'Ledger' },
      { href: '/rate-check', label: 'Rate check' },
      { href: '/adjustments', label: 'Adjustments' },
      { href: '/manual-charges', label: 'Manual charges' },
      { href: '/referrals', label: 'Referral payouts' },
      { href: '/quotes', label: 'Rate sheets' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    items: [
      { href: '/reports', label: 'Reports' },
      { href: '/client-report', label: 'Client report' },
      { href: '/serial-report', label: 'Serial report' },
    ],
  },
]

export const STAFF_SETTINGS: readonly StaffNavItem[] = [
  { href: '/employees', label: 'Employees' },
  { href: '/marketing', label: 'Marketing' },
]

export function staffNavHrefs(): string[] {
  return [
    ...STAFF_NAV.flatMap((group) => group.items.map((item) => item.href)),
    ...STAFF_SETTINGS.map((item) => item.href),
  ]
}

export function staffNavGroupFor(pathname: string): StaffNavGroup['id'] | 'settings' | null {
  for (const group of STAFF_NAV) {
    if (group.items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))) {
      return group.id
    }
  }
  if (STAFF_SETTINGS.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))) {
    return 'settings'
  }
  return null
}
