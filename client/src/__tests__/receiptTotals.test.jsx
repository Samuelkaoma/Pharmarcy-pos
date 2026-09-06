import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// DEF-064. The receipt is a document the customer keeps and may present for
// reclaim, so what it says was charged has to be what was charged. The page
// used to hand it the basket's own arithmetic — a flat 16% on everything — and
// the server had already recorded zero VAT on a basket of zero-rated medicines.
// The API is mocked; the page and the receipt are the real ones.
vi.mock('../api/client', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  upload: vi.fn(),
  blob: vi.fn()
}));

// `toast.promise` is where the sale's success handler actually runs, so unlike
// the other client tests this one has to run it rather than swallow it.
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(async (promise, handlers) => {
      try {
        const res = await (typeof promise === 'function' ? promise() : promise);
        handlers?.success?.(res);
      } catch (err) {
        handlers?.error?.(err);
      }
    })
  })
}));

// The basket's running total animates through a custom element that jsdom
// never upgrades, so any change to the figure throws before the sale is even
// rung up. Swapped for a plain formatted span. The receipt does not use it —
// what this file asserts on is untouched by the stub.
vi.mock('@number-flow/react', async () => {
  const react = await import('react');
  return {
    default: ({ value, format }) =>
      react.createElement('span', null, Number(value).toLocaleString(undefined, format))
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { username: 'pharmacist', full_name: 'Samuel Kaoma', role: 'Pharmacist' },
    token: 'test-token',
    tenant: { name: 'Central Care Pharmacy', currency_symbol: 'K' },
    currency: 'K',
    pharmacyName: 'Central Care Pharmacy',
    checking: false,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
    refreshTenant: vi.fn()
  })
}));

import { get, post } from '../api/client';
import { useCartStore } from '../store/useCartStore';
import POSCheckout from '../pages/POSCheckout';

// Both zero-rated: medicines fall under Group 6 of the Zambian VAT
// (Zero-Rating) Order, which is why the server records no tax on this basket.
const PRODUCTS = [
  {
    product_id: 'p1',
    name: 'Paracetamol 500mg',
    barcode: '600123456701',
    selling_price: '25.00',
    quantity_on_hand: 120,
    requires_prescription: false,
    vat_treatment: 'ZERO_RATED',
    category: 'Analgesic'
  },
  {
    product_id: 'p2',
    name: 'Ibuprofen 400mg',
    barcode: '600123456702',
    selling_price: '40.00',
    quantity_on_hand: 80,
    requires_prescription: false,
    vat_treatment: 'ZERO_RATED',
    category: 'Analgesic'
  }
];

// What the server wrote to `sales` for that basket, returned verbatim.
const SALE_RESPONSE = {
  sale_id: 'sale-1',
  receipt_number: 'REC-20260906-484383',
  customer_id: null,
  customer_name: null,
  subtotal: '90.00',
  tax_amount: '0.00',
  total: '90.00',
  scheme_covered: '0.00',
  patient_payable: '90.00',
  smart_invoice_ref: null,
  till_session_id: 'till-1'
};

beforeEach(() => {
  vi.clearAllMocks();
  useCartStore.setState({ cart: [], prescriptionId: '', paymentType: 'cash' });

  get.mockImplementation((path) => {
    if (path.startsWith('products')) return Promise.resolve({ data: PRODUCTS });
    if (path.startsWith('patients')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });

  post.mockImplementation((path) => {
    if (path === 'sales') return Promise.resolve({ data: SALE_RESPONSE });
    // Interaction screening fires on a two-line basket. Not what is under test.
    return Promise.resolve({ data: { available: false, interactions: [] } });
  });
});

// Paracetamol x2 and Ibuprofen x1, the basket in the defect report.
const ringUpZeroRatedBasket = async () => {
  const user = userEvent.setup();
  render(<POSCheckout />);

  await screen.findByText('Paracetamol 500mg');

  // Scoped to the catalogue: once a line is in the basket its name is on the
  // page twice, and it is the catalogue card that adds another of it.
  const catalogue = within(document.querySelector('.product-grid'));
  await user.click(catalogue.getByText('Paracetamol 500mg'));
  await user.click(catalogue.getByText('Paracetamol 500mg'));
  await user.click(catalogue.getByText('Ibuprofen 400mg'));

  await user.click(screen.getByRole('button', { name: /Complete Sale/i }));
  return user;
};

describe('the receipt reports the sale the server recorded', () => {
  it('shows no VAT and a total equal to the subtotal on a zero-rated basket', async () => {
    await ringUpZeroRatedBasket();

    await screen.findByText('REC-20260906-484383');

    const receipt = document.querySelector('.doc-page--receipt');
    expect(receipt).toBeTruthy();

    // Matched on the start of the label so the VAT row is found whatever the
    // line is called, and the assertion is about the money rather than wording.
    const amountFor = (label) => {
      const row = [...receipt.querySelectorAll('div')].find(
        (el) => el.children.length === 2 && el.children[0].textContent.trim().startsWith(label)
      );
      return row ? row.children[1].textContent.trim() : null;
    };

    expect(amountFor('Subtotal')).toBe('K 90.00');
    // Zero, because the server charged zero. Before the fix this read K 14.40.
    expect(amountFor('VAT')).toBe('K 0.00');
    expect(amountFor('Total')).toBe('K 90.00');
    // The tender line must settle the same figure, not a larger one.
    expect(amountFor('Cash')).toBe('K 90.00');

    // The browser's flat-rate total must appear nowhere on the document.
    expect(receipt.textContent).not.toContain('104.40');
    expect(receipt.textContent).not.toContain('14.40');
  });

  it('does not print a VAT rate the basket was never charged at', async () => {
    await ringUpZeroRatedBasket();
    await screen.findByText('REC-20260906-484383');

    const receipt = document.querySelector('.doc-page--receipt');
    // VAT is settled per product, so no single rate describes a basket.
    expect(receipt.textContent).not.toMatch(/VAT \(\d+%\)/);
  });

  it('makes no Smart Invoice claim when no VAT was charged', async () => {
    await ringUpZeroRatedBasket();
    await screen.findByText('REC-20260906-484383');

    const receipt = document.querySelector('.doc-page--receipt');
    expect(receipt.textContent).not.toContain('VAT has been charged on this sale');
  });

  it('reports standard-rated VAT when that is what the server charged', async () => {
    post.mockImplementation((path) => {
      if (path === 'sales') {
        return Promise.resolve({
          data: { ...SALE_RESPONSE, subtotal: '90.00', tax_amount: '14.40', total: '104.40' }
        });
      }
      return Promise.resolve({ data: { available: false, interactions: [] } });
    });

    await ringUpZeroRatedBasket();
    await screen.findByText('REC-20260906-484383');

    const receipt = document.querySelector('.doc-page--receipt');
    await waitFor(() => {
      expect(receipt.textContent).toContain('K 104.40');
    });
    // The line is only right because the server said so, not because the page
    // assumed a rate.
    expect(receipt.textContent).toContain('VAT has been charged on this sale');
  });
});
