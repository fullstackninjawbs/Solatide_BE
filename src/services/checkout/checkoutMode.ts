/**
 * checkoutMode.ts — which checkout the storefront uses when a customer clicks "Check out".
 *
 * Chosen in Admin → Settings → Checkout mode (PaymentSettings.checkoutMode) and applied on the next
 * click: the storefront asks GET /api/checkout/config every time, so no redeploy or restart.
 *
 *   order_request       customer sends an order request; the admin creates the order and emails
 *                       the payment details (no order, no stock change at checkout)
 *   bank_transfer       our checkout; the order is created "Awaiting payment" and the customer sees
 *                       the PayID / bank transfer details for the method they chose
 *   external_processor  card payments on an external processor's page (redirect) — not connected yet
 *   pay_by_bank         a Pay by Bank provider embedded in our checkout — not connected yet
 *
 * A mode can only be selected when it is ready (bank transfer needs payment details). If the saved
 * mode stops being ready, or nothing was ever saved, the legacy switches decide (the
 * ORDER_REQUEST_CHECKOUT env flag, then the old bank transfer on/off), so deploying this changes
 * nothing until a mode is chosen in Admin.
 */
import PaymentSettings from '../../models/PaymentSettings';
import { getBankTransferSettings, methodsForCountry, type BankTransferSettings } from './bankTransfer';

export const CHECKOUT_MODES = ['order_request', 'bank_transfer', 'external_processor', 'pay_by_bank'] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];
/** What the storefront receives: one of the modes, or the previous Tagada checkout (legacy). */
export type EffectiveCheckoutMode = CheckoutMode | 'tagada';

export const isCheckoutMode = (m: unknown): m is CheckoutMode =>
  typeof m === 'string' && (CHECKOUT_MODES as readonly string[]).includes(m);

export type ModeStatus = 'ready' | 'needs_setup' | 'not_connected';

export interface CheckoutModeOption {
  id: CheckoutMode;
  label: string;
  description: string;
  status: ModeStatus;
  /** Shown when the mode cannot be selected yet */
  hint?: string;
}

/** Bank transfer can take orders: at least one method (AU or international) has its details. */
export const bankTransferReady = (s: BankTransferSettings): boolean =>
  methodsForCountry('AU', s).length > 0 || methodsForCountry('ZZ', s).length > 0;

export function checkoutModeOptions(bank: BankTransferSettings): CheckoutModeOption[] {
  const bankReady = bankTransferReady(bank);
  return [
    {
      id: 'order_request',
      label: 'Order Request',
      description: 'Customers submit an order request. You create the order in Admin and email them the payment details.',
      status: 'ready',
    },
    {
      id: 'bank_transfer',
      label: 'Manual Bank Transfer / PayID',
      description: 'Customers place the order on our checkout and see your PayID / bank transfer details. You mark it paid once the money arrives.',
      status: bankReady ? 'ready' : 'needs_setup',
      ...(bankReady ? {} : { hint: 'Add your PayID or bank account details below first.' }),
    },
    {
      id: 'external_processor',
      label: 'External Payment Processor (card)',
      description: "Customers are sent to the card processor's secure checkout page to pay.",
      status: 'not_connected',
      hint: 'Not connected yet — available once a payment processor is set up.',
    },
    {
      id: 'pay_by_bank',
      label: 'Pay by Bank',
      description: 'Customers stay on our checkout and pay from their bank in the payment section.',
      status: 'not_connected',
      hint: 'Not connected yet — available once a Pay by Bank provider is set up.',
    },
  ];
}

/** Legacy behaviour when no (usable) mode is saved: env flag, then the old bank on/off switch. */
export function legacyCheckoutMode(bank: BankTransferSettings, env: NodeJS.ProcessEnv = process.env): EffectiveCheckoutMode {
  if (env.ORDER_REQUEST_CHECKOUT === 'true') return 'order_request';
  if (bank.enabled && bankTransferReady(bank)) return 'bank_transfer';
  return 'tagada';
}

/** The mode the storefront uses (pure: easy to test). */
export function effectiveCheckoutMode(saved: unknown, bank: BankTransferSettings, env: NodeJS.ProcessEnv = process.env): EffectiveCheckoutMode {
  if (isCheckoutMode(saved)) {
    const option = checkoutModeOptions(bank).find((o) => o.id === saved);
    if (option?.status === 'ready') return saved;
  }
  return legacyCheckoutMode(bank, env);
}

export interface CheckoutModeState {
  mode: EffectiveCheckoutMode;
  saved: CheckoutMode | null;
  bank: BankTransferSettings;
  changedAt?: Date;
  changedBy?: string;
}

export async function getCheckoutModeState(): Promise<CheckoutModeState> {
  const [doc, bank]: [any, BankTransferSettings] = await Promise.all([
    PaymentSettings.findOne().select('checkoutMode checkoutModeChangedAt checkoutModeChangedBy').lean(),
    getBankTransferSettings(),
  ]);
  const saved = isCheckoutMode(doc?.checkoutMode) ? doc.checkoutMode : null;
  return { mode: effectiveCheckoutMode(saved, bank), saved, bank, changedAt: doc?.checkoutModeChangedAt, changedBy: doc?.checkoutModeChangedBy };
}

export async function getEffectiveCheckoutMode(): Promise<EffectiveCheckoutMode> {
  return (await getCheckoutModeState()).mode;
}
