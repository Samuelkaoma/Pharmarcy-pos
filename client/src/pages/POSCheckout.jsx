import React, { useState, useEffect } from 'react';
import { Search, ShoppingCart, Plus, Minus, Trash2, Barcode, Printer, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import NumberFlow from '@number-flow/react';
import { get, post } from '../api/client';
import { useCartStore } from '../store/useCartStore';
import { useAuth } from '../context/AuthContext';
import Receipt from '../components/Receipt';

// Money off the wire arrives as a fixed-point string. Anything that is not a
// number is not shown as one: it becomes 0 rather than printing NaN on a
// receipt, and the sale's own record in the database remains the authority.
const toAmount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export default function POSCheckout() {
  const { tenant, pharmacyName, currency, user } = useAuth();
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptData, setReceiptData] = useState(null);
  // The cart is emptied the moment the sale succeeds, so what was sold has to
  // be captured before that or the receipt renders with no lines.
  const [receiptItems, setReceiptItems] = useState([]);
  const [receiptTotals, setReceiptTotals] = useState({ subtotal: 0, vat: 0, total: 0 });
  // SIMFIS, the simulated fiscalisation service. Held separately from the sale
  // because it is not part of the sale: it is a demonstration of a mechanism
  // this system is not authorised to perform for real.
  const [fiscal, setFiscal] = useState(null);
  const [fiscalising, setFiscalising] = useState(false);
  // Interaction screening. `undefined` means not yet asked; the shape that
  // comes back distinguishes "screened and clear" from "could not be screened",
  // and those two must never be shown the same way.
  const [screen, setScreen] = useState(undefined);
  // The patient on the sale. Optional — a walk-in buying paracetamol is not a
  // registered patient — but naming one is what lets the server resolve any
  // insurance cover, so without this control cover could never be applied.
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
  // `undefined` means not looked up yet, `null` means looked up and not covered.
  // The two must not render the same way: one is silence, the other is an answer.
  const [coverage, setCoverage] = useState(undefined);
  const [rxOptions, setRxOptions] = useState([]);
  // Below 900px the basket is a bottom sheet rather than a column. Collapsed it
  // still shows the item count, the running total and the button that takes the
  // money — the three things a cashier must be able to reach without hunting.
  // The class does nothing at desktop widths, where the basket is always open.
  const [cartOpen, setCartOpen] = useState(false);

  const {
    cart, 
    prescriptionId, 
    paymentType, 
    setPrescriptionId, 
    setPaymentType, 
    addToCart, 
    updateQty, 
    removeFromCart, 
    clearCart,
    getSubtotal,
    getVat,
    getGrandTotal
  } = useCartStore();

  useEffect(() => {
    loadProducts();
    loadCustomers();
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!customerId) {
      setCoverage(undefined);
      setRxOptions([]);
      setPrescriptionId('');
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const res = await get(`insurance/coverage/${customerId}`);
        if (!cancelled) setCoverage(res?.data ?? null);
      } catch (e) {
        if (!cancelled) setCoverage(undefined);
        toast.error('Could not check insurance cover');
      }
    })();

    (async () => {
      try {
        const res = await get(`prescriptions?status=VERIFIED&customerId=${customerId}`);
        if (!cancelled) setRxOptions(res?.data ?? []);
      } catch (e) {
        if (!cancelled) setRxOptions([]);
      }
    })();

    return () => { cancelled = true; };
  }, [customerId]);

  const loadProducts = async () => {
    try {
      const res = await get('products');
      if (res?.data) {
        setProducts(res.data);
        return;
      }
    } catch (e) {
      toast.error('Failed to load products from database');
    }

    // No invented catalogue. A failed load is reported, not disguised as stock.
    setProducts([]);
  };

  const loadCustomers = async () => {
    try {
      const res = await get('patients');
      if (res?.data) {
        setCustomers(res.data);
        return;
      }
    } catch (e) {
      toast.error('Failed to load patients');
    }
    setCustomers([]);
  };

  const handleBarcodeScan = (e) => {
    e.preventDefault();
    if (!barcodeInput) return;
    const found = products.find(p => p.barcode === barcodeInput);
    if (found) {
      addToCart(found);
      toast.success(`Added ${found.name} to cart`);
      setBarcodeInput('');
    } else {
      toast.error(`Product with barcode '${barcodeInput}' not found`);
    }
  };

  const subtotal = getSubtotal();
  const vat = getVat();
  const grandTotal = getGrandTotal();

  // Preview of the split the server will perform. Shown so the cashier can say
  // what the patient owes before taking payment; the recorded figures are the
  // server's, computed inside the sale transaction.
  const coverPercent = coverage ? parseFloat(coverage.cover_percent) : 0;
  const schemeCovers = coverage ? grandTotal * (coverPercent / 100) : 0;
  const patientPays = grandTotal - schemeCovers;

  const handleCompleteSale = async () => {
    if (cart.length === 0) return;
    const hasRx = cart.some(i => i.requires_prescription);
    if (hasRx && !prescriptionId) {
      toast.error('Prescription ID is required for prescription drugs');
      return;
    }

    const soldItems = cart.map((i) => ({ ...i }));

    toast.promise(
      post('sales', {
        items: cart.map(i => ({ productId: i.product_id, quantity: i.qty })),
        paymentType,
        prescriptionId: prescriptionId || null,
        // The server resolves cover from this and splits the bill. The figures
        // shown alongside are a preview of that calculation, never the input to
        // it — the split that is recorded is the one the server computes.
        customerId: customerId || null
      }),
      {
        loading: 'Processing transaction...',
        success: (res) => {
          if (res?.data) {
            setReceiptData(res.data);
            setReceiptItems(soldItems);
            // The receipt reports what the server recorded and charged, never
            // the browser's arithmetic. VAT is decided per product inside the
            // sale transaction — medicines are zero-rated under Group 6 of the
            // Zambian VAT (Zero-Rating) Order — so the flat 16% this page uses
            // for its running preview printed a VAT line and a total that were
            // never taken, on a document the customer keeps.
            setReceiptTotals({
              subtotal: toAmount(res.data.subtotal),
              vat: toAmount(res.data.tax_amount),
              total: toAmount(res.data.total)
            });
            setFiscal(null);
            setShowReceipt(true);
            clearCart();
            // Cleared with the cart. A patient left selected would attach the
            // next customer's sale to them, and bill their insurer for it.
            setCustomerId('');
            return 'Sale completed successfully!';
          }
          throw new Error(res?.error || 'Sale transaction failed');
        },
        error: (err) => err.message || 'Failed to complete transaction'
      }
    );
  };

  // Screen the basket whenever it holds two or more medicines. Advisory: it
  // informs the pharmacist and never blocks the sale, because a directory
  // outage must not stop a pharmacy trading.
  useEffect(() => {
    const productIds = cart.map((i) => i.product_id);
    if (productIds.length < 2) { setScreen(undefined); return; }

    let cancelled = false;
    (async () => {
      const res = await post('drugs/interactions', { productIds });
      if (cancelled) return;
      // A missing response is itself "could not be screened". It must not read
      // as clear.
      setScreen(res?.data ? { ...res.data, message: res.message } : { available: false, interactions: [] });
    })();

    return () => { cancelled = true; };
  }, [cart]);

  const handleFiscalise = async () => {
    if (!receiptData?.sale_id) return;
    setFiscalising(true);

    const res = await post(`fiscal/sales/${receiptData.sale_id}/fiscalise`, {});
    if (res?.data) {
      setFiscal(res.data);
      toast.success('Fiscalised by SIMFIS', {
        description: 'Simulated only — this is not a valid ZRA tax invoice.'
      });
    } else {
      toast.error('Could not fiscalise the sale', { description: res?.error || 'The server rejected it.' });
    }
    setFiscalising(false);
  };

  const filteredProducts = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || (p.barcode && p.barcode.includes(search)));

  return (
    <div className="pos-main">
      {/* LEFT CATALOG */}
      <div className="catalog-section">
        <div className="pos-search-row" style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
          <form onSubmit={handleBarcodeScan} style={{ display: 'flex', gap: '8px', flex: 1 }}>
            <input
              type="text"
              placeholder="Scan Barcode (e.g. 600123456701)..."
              className="input-field"
              value={barcodeInput}
              onChange={e => setBarcodeInput(e.target.value)}
            />
            <button type="submit" className="btn btn-primary"><Barcode size={18} /> Scan</button>
          </form>

          <input
            type="text"
            placeholder="Search drug..."
            className="input-field pos-search-input"
            style={{ width: '200px' }}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="product-grid">
          {filteredProducts.map(p => (
            <div
              key={p.product_id}
              className="product-card"
              onClick={() => {
                // Out of stock is refused here as well as by the checkout
                // guard, so the cashier finds out before the patient is at the
                // counter rather than after.
                if ((p.quantity_on_hand ?? 0) <= 0) {
                  toast.error(`${p.name} is out of stock`);
                  return;
                }
                addToCart(p);
                toast.success(`Added ${p.name}`);
              }}
              style={{ opacity: (p.quantity_on_hand ?? 0) <= 0 ? 0.55 : 1 }}
            >
              <div>
                <h4 style={{ color: '#fff', fontSize: '1rem' }}>{p.name}</h4>
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                  <span className="badge badge-blue">{p.category}</span>
                  {p.requires_prescription && <span className="badge badge-yellow">Rx Required</span>}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '12px' }}>
                {/* The real figure. `|| 100` here showed "Stock: 100" for
                    anything with none left, which is the catalogue inventing
                    stock the pharmacy does not hold. */}
                <span className="stock-text" style={{ fontSize: '0.8rem', color: (p.quantity_on_hand ?? 0) <= 0 ? 'var(--danger)' : 'var(--text-2)' }}>
                  {(p.quantity_on_hand ?? 0) <= 0 ? 'Out of stock' : `Stock: ${p.quantity_on_hand}`}
                </span>
                <span className="price-text" style={{ color: 'var(--ok)', fontWeight: '700', fontSize: '1.1rem' }}>
                  {currency} <NumberFlow value={parseFloat(p.selling_price)} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tapping away from an open sheet closes it. Phone only — at desktop
          widths the basket is a column and there is nothing to close. */}
      <div
        className={`cart-scrim ${cartOpen ? 'is-open' : ''}`}
        onClick={() => setCartOpen(false)}
        aria-hidden="true"
      />

      {/* RIGHT BASKET — a bottom sheet below 900px, a column above it */}
      <div className={`cart-section ${cartOpen ? 'is-open' : ''}`}>
        {/* The permanently visible part of the sheet on a phone. It is a real
            button because it is the control that opens the basket. */}
        <button
          type="button"
          className="cart-handle"
          onClick={() => setCartOpen((open) => !open)}
          aria-expanded={cartOpen}
        >
          <span className="cart-handle-label">
            <ShoppingCart size={16} />
            {cart.length} {cart.length === 1 ? 'item' : 'items'}
          </span>
          <span className="cart-handle-total">
            {currency} <NumberFlow value={grandTotal} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
          </span>
          {cartOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>

        <div className="cart-scroll">
        <div>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <ShoppingCart size={20} color="var(--tenant-primary)" /> Active Sale Basket ({cart.length})
          </h3>

          {cart.length === 0 ? (
            <p style={{ color: 'var(--text-3)', textAlign: 'center', margin: '40px 0' }}>Scan barcode or click items to add to cart.</p>
          ) : (
            <table className="cart-table">
              <thead>
                <tr><th>Item</th><th>Qty</th><th>Subtotal</th><th></th></tr>
              </thead>
              <tbody>
                {cart.map(item => (
                  <tr key={item.product_id}>
                    <td>{item.name}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        <button className="qty-btn" onClick={() => updateQty(item.product_id, -1)}><Minus size={12}/></button>
                        <span>{item.qty}</span>
                        <button className="qty-btn" onClick={() => updateQty(item.product_id, 1)}><Plus size={12}/></button>
                      </div>
                    </td>
                    <td style={{ color: 'var(--ok)' }}>
                      {currency} <NumberFlow value={item.subtotal} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
                    </td>
                    <td><button className="icon-btn text-danger" onClick={() => removeFromCart(item.product_id)}><Trash2 size={16}/></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {screen && (
            <div
              className="summary-card"
              style={{
                marginBottom: '12px',
                borderLeft: `3px solid ${
                  !screen.available ? 'var(--warn)' : screen.interactions.length > 0 ? 'var(--danger)' : 'var(--ok)'
                }`
              }}
            >
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <strong style={{ fontSize: '0.85rem' }}>
                    {!screen.available
                      ? 'Basket could not be screened'
                      : screen.interactions.length > 0
                        ? 'Possible interactions'
                        : 'No known interactions'}
                  </strong>
                  {/* Never claim a clear basket when nothing ran. The free NLM
                      interaction API was withdrawn in January 2024 and the
                      check fails closed until a licensed source is configured. */}
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', margin: '3px 0 0' }}>
                    {!screen.available
                      ? 'No interaction source is configured, so nothing was checked. Use your own judgement.'
                      : screen.interactions.length > 0
                        ? screen.interactions.map((i) => i.description || i.summary).join(' · ')
                        : `${screen.checked} medicines screened.`}
                  </p>
                </div>
              </div>
            </div>
          )}

          {cart.some(i => i.requires_prescription) && (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>Prescription (Required):</label>
              {!customerId ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--warn)', margin: '4px 0' }}>
                  Select a patient first to see their verified prescriptions.
                </p>
              ) : rxOptions.length === 0 ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--warn)', margin: '4px 0' }}>
                  No verified prescriptions for this patient. Create and verify one on the Prescriptions page first.
                </p>
              ) : (
                <select
                  className="input-field"
                  value={prescriptionId}
                  onChange={e => setPrescriptionId(e.target.value)}
                >
                  <option value="">— Select a prescription —</option>
                  {rxOptions.map(rx => (
                    <option key={rx.prescription_id} value={rx.prescription_id}>
                      {rx.item_summary || 'Prescription'} — {rx.doctor_name || 'Unknown doctor'}
                      {rx.has_lapsed ? ' (EXPIRED)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>
              Patient (optional — needed for insurance cover):
            </label>
            <select
              className="input-field"
              style={{ width: '100%' }}
              value={customerId}
              onChange={e => setCustomerId(e.target.value)}
            >
              <option value="">Walk-in — no patient recorded</option>
              {customers.map(c => (
                <option key={c.customer_id} value={c.customer_id}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ''}
                </option>
              ))}
            </select>

            {/* Three distinct states, deliberately not collapsed into two: no
                patient chosen, chosen and covered, chosen and not covered. */}
            {customerId !== '' && coverage === undefined && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-2)', marginTop: '6px' }}>
                Cover could not be checked — the full amount will be billed to the patient.
              </div>
            )}
            {customerId !== '' && coverage === null && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-2)', marginTop: '6px' }}>
                No active cover on file. The patient pays in full.
              </div>
            )}
            {coverage && (
              <div style={{ fontSize: '0.78rem', color: 'var(--ok)', marginTop: '6px' }}>
                {coverage.name} · covers {coverPercent}%
                {coverage.member_number ? ` · member ${coverage.member_number}` : ''}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            {['cash', 'card', 'mobile'].map(type => (
              <button
                key={type}
                className={`btn pay-btn ${paymentType === type ? 'btn-success' : 'btn-secondary'}`}
                style={{ flex: 1, textTransform: 'capitalize' }}
                onClick={() => setPaymentType(type)}
              >
                {type}
              </button>
            ))}
          </div>

          <div className="summary-card">
            <div className="summary-row">
              <span>Subtotal:</span>
              <span>{currency} <NumberFlow value={subtotal} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} /></span>
            </div>
            <div className="summary-row">
              <span>VAT (16%):</span>
              <span>{currency} <NumberFlow value={vat} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} /></span>
            </div>
            <div className="summary-row summary-total">
              <span>Total:</span>
              <span style={{ color: 'var(--ok)' }}>
                {currency} <NumberFlow value={grandTotal} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
              </span>
            </div>

            {/* The total is unchanged by cover. What changes is who pays it. */}
            {coverage && (
              <>
                <div className="summary-row">
                  <span>{coverage.name} pays ({coverPercent}%):</span>
                  <span>−{currency} <NumberFlow value={schemeCovers} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} /></span>
                </div>
                <div className="summary-row summary-total">
                  <span>Patient pays:</span>
                  <span style={{ color: 'var(--ok)' }}>
                    {currency} <NumberFlow value={patientPays} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
        </div>

        {/* Outside the scrolling region on purpose: on a phone this strip stays
            put at the bottom of the sheet whether the basket is open or shut, so
            taking the money is never something you have to scroll to find. */}
        <div className="cart-footer">
          <button className="btn btn-success cart-complete" onClick={handleCompleteSale} disabled={cart.length === 0}>
            <CheckCircle size={18} /> Complete Sale &amp; Print Receipt
          </button>
        </div>
      </div>

      {showReceipt && (
        <Receipt
          sale={receiptData}
          items={receiptItems}
          totals={receiptTotals}
          tenant={tenant}
          servedBy={user?.full_name || user?.username}
          currency={currency}
          paymentType={paymentType}
          fiscal={fiscal}
          onFiscalise={handleFiscalise}
          fiscalising={fiscalising}
          onClose={() => setShowReceipt(false)}
        />
      )}
    </div>
  );
}
