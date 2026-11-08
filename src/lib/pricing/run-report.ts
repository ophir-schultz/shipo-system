// A GET to the live order sheet. It does not import, approve, or download.

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function liveReportHref(
  clientId: string,
  dateFrom: string,
  dateTo: string,
): { ok: true; href: string } | { ok: false; reason: string } {
  if (!clientId) {
    return {
      ok: false,
      reason: 'Choose one client. Run report shows that client’s live orders. All clients stays on the imported table.',
    }
  }
  if (!ISO.test(dateFrom) || !ISO.test(dateTo) || dateFrom > dateTo) {
    return { ok: false, reason: 'From and to must be dates, with from on or before to.' }
  }
  const query = new URLSearchParams({ client: clientId, from: dateFrom, to: dateTo })
  return { ok: true, href: `/client-report/activity?${query}` }
}
