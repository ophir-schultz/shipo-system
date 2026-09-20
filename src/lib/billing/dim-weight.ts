/**
 * Dimensional weight rules.
 *
 * USPS: divisor 139, applies only above 1 cubic foot.
 *   Ref: USPS price change of 2026-07-12
 *   https://www.easypost.com/blog/usps-july-12-2026-price-change/
 *
 * UPS: divisor 166. The cubic-foot threshold is SERVICE-dependent -- ground
 *   services gate at 1 cubic foot, air services do not gate at all.
 *
 *   Measured 2026-08-29 against live ShipStation getrates quotes on both the
 *   `ups` and `ups_walleted` accounts, Wilmington DE -> Beverly Hills CA,
 *   2 lb actual, cheapest ground service:
 *
 *     box         cu in   ups_walleted   ups      billed as
 *     21x21x2       882      $10.30    $13.05     2 lb (actual)
 *     12x12x12     1728      $10.30    $13.05     2 lb (actual)
 *     15x12x10     1800      $20.48    $23.35     11 lb  = ceil(1800/166)
 *     16x14x10     2240      $23.52    $27.76     14 lb  = ceil(2240/166)
 *     20x15x10     3000      $30.17       --      19 lb  = ceil(3000/166)
 *
 *   Every box above the threshold matches divisor 166 exactly and 139 never.
 *   At exactly 1728 cu in the parcel still bills on actual weight.
 *
 *   AIR IS DIFFERENT. Re-measured the same day, per service, on the client's
 *   real box (21x21x2 = 882 cu in, well UNDER a cubic foot), 2 lb actual,
 *   ups_walleted, against that service's own no-dims flat rates:
 *
 *     service                21x21x2   2 lb flat   6 lb flat   bills as
 *     UPS Ground              $10.79     $10.79      $17.11     2 lb actual
 *     UPS Ground Saver        $10.30     $10.30      $17.02     2 lb actual
 *     UPS 3 Day Select        $14.97     $14.97      $26.84     2 lb actual
 *     UPS 2nd Day Air         $36.84     $15.17      $36.84     6 lb DIM
 *     UPS Next Day Air Saver  $67.79     $50.41      $67.79     6 lb DIM
 *     UPS Next Day Air        $75.41     $58.03      $75.41     6 lb DIM
 *     UPS Next Day Air Early $105.41     $88.03     $105.41     6 lb DIM
 *
 *   ceil(882/166) = 6, and every air service matches its 6 lb flat rate to the
 *   cent while every ground service matches its 2 lb flat rate to the cent.
 *   So on DAP: air applies DIM to every parcel regardless of size; ground and
 *   3 Day Select only above 1728 cu in.
 *
 *   The standard `ups` card behaves differently off ground. Same box, same
 *   lane, matched against each service's own flat-rate ladder:
 *
 *     service                21x21x2   matches   implies
 *     UPS Ground              $13.05    2 lb     actual weight (gated)
 *     UPS Ground Saver        $13.11    2 lb     actual weight (gated)
 *     UPS 3 Day Select        $68.75    7 lb     DIM, ceil(882/139)
 *     UPS 2nd Day Air         $81.86    7 lb     DIM, ceil(882/139)
 *     UPS Next Day Air Saver $127.70    7 lb     DIM, ceil(882/139)
 *     UPS Next Day Air       $143.07    7 lb     DIM, ceil(882/139)
 *     UPS Next Day Air Early $299.97    7 lb     DIM, ceil(882/139)
 *
 *   ceil(882/166) = 6 and ceil(882/139) = 7, so the standard card is on 139
 *   off ground while DAP is on 166. Ground stays 166 on both -- the 1800 cu in
 *   box quoted $23.35 on standard = 11 lb = ceil(1800/166), not 13.
 *
 *   Caveat: the air/3-Day numbers come from one lane at one actual weight.
 *   Ground is measured across the full 1-50 lb ladder and is the volume that
 *   matters; treat the off-ground divisor as provisional.
 *
 *   When the service is unknown we assume ground (gated, 166). Ground is ~all
 *   of the volume, and the failure we are correcting was over-billing ground.
 *
 * FedEx / DHL: left on the previous behaviour (139, no threshold) because it
 *   has not been measured. Do not assume the UPS findings transfer -- verify
 *   the same way before changing these.
 */

const DIM_DIVISOR_DEFAULT = 139
const DIM_DIVISOR_UPS = 166
const CUBIC_FOOT_IN = 1728

function isUps(carrier: string | null | undefined): boolean {
  return (carrier ?? '').toLowerCase().includes('ups')
}

/**
 * The Digital Access Program card, carrierCode `ups_walleted`. It prices very
 * differently from the standard `ups` accounts and, as measured below, applies
 * a different DIM divisor off the ground services.
 */
function isUpsDap(carrier: string | null | undefined): boolean {
  return (carrier ?? '').toLowerCase().includes('walleted')
}

/**
 * Ground-family services: UPS Ground, UPS Ground Saver, SurePost.
 *
 * An unknown/blank service is treated as ground on purpose. Ground is
 * effectively all of the volume, and the failure being corrected here was
 * over-billing ground parcels, so ground is the safe default.
 */
function isUpsGround(service: string | null | undefined): boolean {
  const s = (service ?? '').toLowerCase()
  if (!s) return true
  return s.includes('ground') || s.includes('surepost')
}

/**
 * Carriers/services that only apply DIM above 1 cubic foot.
 *
 * USPS does. FedEx and DHL apply it to every package as far as we know, so
 * they must not inherit the threshold.
 *
 * UPS is split. Ground gates on both cards. Off ground, only the DAP card
 * still gates (its 3 Day Select bills actual weight on an 882 cu in box);
 * the standard card applies DIM to every non-ground parcel.
 */
function usesCubicFootThreshold(
  carrier: string | null | undefined,
  service: string | null | undefined
): boolean {
  const c = (carrier ?? '').toLowerCase()
  if (c.includes('fedex') || c.includes('dhl')) return false
  if (!isUps(carrier)) return true
  if (isUpsGround(service)) return true
  // Non-ground UPS: air never gates, on either card.
  if ((service ?? '').toLowerCase().includes('air')) return false
  // Non-ground, non-air (3 Day Select): gates on DAP only.
  return isUpsDap(carrier)
}

/**
 * UPS uses 166 on ground on both cards, and 166 across the board on DAP.
 * The standard card falls back to 139 off its ground services -- measured on
 * the 882 cu in box, where every standard-card air service and 3 Day Select
 * matched its 7 lb flat rate, and ceil(882/139) = 7 while ceil(882/166) = 6.
 */
function dimDivisor(
  carrier: string | null | undefined,
  service: string | null | undefined
): number {
  if (!isUps(carrier)) return DIM_DIVISOR_DEFAULT
  if (isUpsDap(carrier) || isUpsGround(service)) return DIM_DIVISOR_UPS
  return DIM_DIVISOR_DEFAULT
}

/**
 * Dimensional weight in ounces, or null when DIM does not apply and the
 * package should bill on actual weight alone.
 */
export function calcDimWeightOz(
  lengthIn: number,
  widthIn: number,
  heightIn: number,
  carrier?: string | null,
  service?: string | null
): number | null {
  if (!(lengthIn > 0 && widthIn > 0 && heightIn > 0)) return null

  // Fractional dimensions round up to the next whole inch before cubing.
  const cubicIn = Math.ceil(lengthIn) * Math.ceil(widthIn) * Math.ceil(heightIn)

  if (usesCubicFootThreshold(carrier, service) && cubicIn <= CUBIC_FOOT_IN) {
    return null
  }

  return parseFloat(((cubicIn / dimDivisor(carrier, service)) * 16).toFixed(2))
}

export function calcBilledWeightOz(weightOz: number, dimWeightOz: number | null): number {
  return dimWeightOz != null ? Math.max(weightOz, dimWeightOz) : weightOz
}
