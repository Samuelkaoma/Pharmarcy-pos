import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Printer, Stamp } from 'lucide-react';

/**
 * The paper a customer leaves the counter with.
 *
 * Printed on white, not in the app's dark theme: a receipt is a physical
 * document and inherits none of the screen's surfaces.
 *
 * Portalled to document.body so the print rule can drop everything else with
 * `display: none`. `visibility: hidden` was tried first and is the wrong tool —
 * it hides the ink but keeps the box, so the workspace behind was still laid
 * out at full height and the receipt printed after several blank pages.
 * `display` removes the box entirely, but cannot be set on an ancestor of the
 * thing that must survive, which is why this renders as a sibling of the app
 * root rather than inside the modal tree.
 */

const money = (currency, n) =>
  `${currency} ${Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const fmtDateTime = (value) =>
  new Date(value || Date.now()).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

const PAYMENT_LABELS = {
  cash: 'Cash',
  card: 'Card',
  mobile_money: 'Mobile Money',
  insurance: 'Insurance'
};

export default function Receipt({
  sale, items, totals, tenant, servedBy, currency = 'K', paymentType,
  fiscal, onFiscalise, fiscalising, onClose
}) {
  // Escape closes the receipt. Capture phase so it does not reach the modal
  // sitting behind it and close both at once.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const th = {
    textAlign: 'left', padding: '7px 6px', fontSize: '10px', textTransform: 'uppercase',
    letterSpacing: '0.05em', color: '#555', borderBottom: '2px solid #111'
  };
  const td = {
    padding: '7px 6px', fontSize: '12px', color: '#111', borderBottom: '1px solid #e4e4e4',
    verticalAlign: 'top'
  };

  const line = (label, value, strong = false) => (
    <div
      style={{
        display: 'flex', justifyContent: 'space-between', gap: '32px', padding: '4px 0',
        fontSize: strong ? '14px' : '12px', fontWeight: strong ? 800 : 500, color: '#111',
        borderTop: strong ? '2px solid #111' : undefined, marginTop: strong ? '4px' : undefined
      }}
    >
      <span>{label}</span><span>{value}</span>
    </div>
  );

  const subtotal = totals?.subtotal ?? 0;
  const vat = totals?.vat ?? 0;
  const total = totals?.total ?? 0;

  return createPortal(
    <div className="doc-overlay">
      <div className="doc-toolbar doc-no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>
          <Printer size={15} /> Print receipt
        </button>
        {/* Fiscalisation is a deliberate action, not something that happens to
            every sale silently. SIMFIS is a simulation, and a simulated fiscal
            block should only appear on a receipt because someone asked for it. */}
        {onFiscalise && !fiscal && (
          <button className="btn btn-secondary" onClick={onFiscalise} disabled={fiscalising}>
            <Stamp size={15} /> {fiscalising ? 'Fiscalising…' : 'Fiscalise (simulated)'}
          </button>
        )}
        <button className="btn btn-secondary" onClick={onClose}>
          <X size={15} /> Close
        </button>
      </div>

      <div className="doc-print-root">
        <div className="doc-page doc-page--receipt">
          <header className="doc-letterhead">
            <div style={{ display: 'flex', gap: '11px', alignItems: 'center' }}>
              {tenant?.logo_url && (
                <img
                  src={tenant.logo_url}
                  alt=""
                  style={{ height: '38px', width: 'auto' }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div>
                <div style={{ fontSize: '17px', fontWeight: 900, color: '#111' }}>
                  {tenant?.name || 'Pharmacy'}
                </div>
                <div style={{ fontSize: '10.5px', color: '#555', marginTop: '3px', lineHeight: 1.5 }}>
                  {tenant?.address}
                  {tenant?.phone && <><br />{tenant.phone}</>}
                  {tenant?.license_number && <><br />Licence: {tenant.license_number}</>}
                </div>
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '17px', fontWeight: 900, textTransform: 'uppercase', color: '#111', letterSpacing: '0.03em' }}>
                Sale Receipt
              </div>
              <div style={{ fontSize: '11px', color: '#555', marginTop: '4px' }}>
                <strong>No.</strong> {sale?.receipt_number || '—'}
              </div>
              <div style={{ fontSize: '11px', color: '#555' }}>{fmtDateTime(sale?.date_time)}</div>
            </div>
          </header>

          {/* A till receipt is the only record tying an operator to a specific
              transaction, so who served it belongs on the customer's copy. */}
          <section className="doc-parties">
            <div>
              <div className="doc-label">Customer</div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#111' }}>
                {sale?.customer_name || 'Counter sale'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="doc-label">Served by</div>
              <div style={{ fontSize: '12px', color: '#111' }}>{servedBy || '—'}</div>
            </div>
          </section>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '14px' }}>
            <thead>
              <tr>
                <th style={th}>Item</th>
                <th style={{ ...th, textAlign: 'right', width: '48px' }}>Qty</th>
                <th style={{ ...th, textAlign: 'right', width: '86px' }}>Price</th>
                <th style={{ ...th, textAlign: 'right', width: '92px' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, idx) => (
                <tr key={i.product_id ?? idx}>
                  <td style={td}>
                    {i.name}
                    {i.requires_prescription && (
                      <span style={{ display: 'block', fontSize: '10px', color: '#8a6d00', marginTop: '2px' }}>
                        Prescription only
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{i.qty}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(currency, i.selling_price)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(currency, Number(i.selling_price) * i.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
            <div style={{ minWidth: '230px' }}>
              {line('Subtotal', money(currency, subtotal))}
              {/* No rate is named. VAT is decided per product on the server —
                  medicines are zero-rated, ordinary goods are standard-rated —
                  so a basket has no single rate to quote, and printing "16%"
                  beside a zero-rated line stated a rate that was never applied. */}
              {line('VAT', money(currency, vat))}
              {line('Total', money(currency, total), true)}

              <div style={{ marginTop: '10px', paddingTop: '9px', borderTop: '1px dashed #bbb' }}>
                {line(PAYMENT_LABELS[paymentType] ?? paymentType ?? 'Cash', money(currency, total))}
              </div>
            </div>
          </section>

          {/* A dispensed prescription is a clinical record, and the receipt is
              proof of purchase, not of dispensing. Saying so keeps the two from
              being confused. */}
          {sale?.prescription_id && (
            <section className="doc-note">
              Dispensed against prescription <strong>{sale.prescription_id}</strong>. This receipt is
              proof of purchase and is not a record of clinical dispensing.
            </section>
          )}

          {/* A genuine Smart Invoice reference, issued elsewhere by an approved
              system and recorded here. */}
          {sale?.smart_invoice_ref && (
            <section className="doc-note">
              ZRA Smart Invoice reference: <strong>{sale.smart_invoice_ref}</strong>
            </section>
          )}

          {/* The simulation. Marked so heavily that it cannot be mistaken for
              the real thing, which is the entire condition of showing it. */}
          {fiscal && (
            <section className="doc-note doc-note--simulated">
              <strong className="doc-sim-banner">Simulated fiscalisation — not a valid tax invoice</strong>
              <div className="doc-sim-grid">
                <span>Reference</span><span>{fiscal.reference}</span>
                <span>Device</span><span>{fiscal.device_id}</span>
                <span>Counter</span><span>{fiscal.fiscal_counter}</span>
                <span>Verification</span><span>{fiscal.verification_code}</span>
              </div>
              <p className="doc-sim-note">{fiscal.notice}</p>
            </section>
          )}

          {!sale?.smart_invoice_ref && !fiscal && Number(totals?.vat) > 0 && (
            <section className="doc-note">
              VAT has been charged on this sale. The valid tax invoice for reclaim purposes is the
              ZRA Smart Invoice, issued separately; this receipt is not a substitute for it.
            </section>
          )}

          <footer className="doc-footer">
            <div>Goods remain checkable against this receipt. Medicines are not returnable once dispensed.</div>
            <div style={{ marginTop: '4px' }}>Thank you for your visit.</div>
          </footer>
        </div>
      </div>
    </div>,
    document.body
  );
}
