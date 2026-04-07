// ============================
// ParkIQ Backend — server.js
// ============================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// ---- Middleware ----
app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests' } }));

// ---- In-memory database (replace with real DB in production) ----
const db = {
  facilities: require('./data/facilities.json'),
  slots: {},        // facilityId -> [slots]
  bookings: [],
  vehicles: [],     // GPS tracked vehicles
  payments: [],
  anomalies: []
};

// Generate initial slot data for each facility
db.facilities.forEach(f => {
  db.slots[f.id] = generateSlots(f.id, f.total, f.free, f.occupied, f.booked);
});

function generateSlots(facilityId, total, free, occupied, booked) {
  const slots = [];
  const zones = ['A', 'B', 'C'];
  let freeLeft = free, occLeft = occupied, bookLeft = booked;
  for (let i = 0; i < total; i++) {
    const zone = zones[Math.floor(i / (total / zones.length))];
    const num = String((i % Math.ceil(total / zones.length)) + 1).padStart(2, '0');
    let status;
    if (occLeft > 0 && (freeLeft === 0 || Math.random() < 0.6)) { status = 'occupied'; occLeft--; }
    else if (bookLeft > 0 && Math.random() < 0.2) { status = 'booked'; bookLeft--; }
    else if (freeLeft > 0) { status = 'free'; freeLeft--; }
    else { status = 'occupied'; }
    // ~3% flagged
    if (status === 'occupied' && Math.random() < 0.03) status = 'flagged';
    slots.push({
      id: `${zone}-${num}`,
      facilityId,
      zone,
      floor: zone === 'A' ? 'Ground' : zone === 'B' ? 'Level 1' : 'Level 2',
      status,
      vehicleNum: status !== 'free' ? generateFakePlate() : null,
      entryTime: status === 'occupied' ? new Date(Date.now() - Math.random() * 5 * 3600000).toISOString() : null,
      bookedBy: status === 'booked' ? generateFakePlate() : null
    });
  }
  return slots;
}

function generateFakePlate() {
  const districts = ['01','04','07','09','22','33'];
  const letters = 'ABCDEFGHJKLMNPQRSTVWXY';
  const d = districts[Math.floor(Math.random() * districts.length)];
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const n = String(Math.floor(Math.random() * 9000 + 1000));
  return `TN ${d} ${l1}${l2} ${n}`;
}

// ---- AI Pricing Engine ----
function getAIPrice(basePrice) {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=Sun, 6=Sat
  let multiplier = 1.0;
  let reason = 'Standard rate';
  let type = 'normal';

  // Festival/weekend surge
  if (day === 0 || day === 6) { multiplier = 1.5; reason = 'Weekend surge'; type = 'up'; }
  // Evening peak
  else if (hour >= 17 && hour < 21) { multiplier = 1.3; reason = 'Evening peak hours'; type = 'up'; }
  // Morning rush
  else if (hour >= 8 && hour < 10) { multiplier = 1.2; reason = 'Morning rush hour'; type = 'up'; }
  // Night discount
  else if (hour >= 23 || hour < 6) { multiplier = 0.4; reason = 'Late night discount'; type = 'down'; }
  // Midday slight discount
  else if (hour >= 11 && hour < 14) { multiplier = 0.9; reason = 'Midday off-peak'; type = 'down'; }

  return {
    basePrice,
    currentPrice: Math.round(basePrice * multiplier),
    multiplier,
    reason,
    type,
    timestamp: now.toISOString()
  };
}

// ---- Anomaly Detection Engine ----
function detectAnomalies() {
  const anomalies = [];
  Object.entries(db.slots).forEach(([facilityId, slots]) => {
    slots.forEach(slot => {
      if (slot.status === 'flagged') {
        anomalies.push({
          id: uuidv4(),
          slotId: slot.id,
          facilityId,
          vehicleNum: slot.vehicleNum,
          type: 'long_stay',
          description: `Vehicle ${slot.vehicleNum} has been in slot ${slot.id} for an extended period`,
          severity: 'high',
          detectedAt: new Date().toISOString(),
          resolved: false
        });
      }
    });
  });
  return anomalies;
}

// ---- Calculate Bill ----
function calculateBill(entryTime, exitTime, baseRate) {
  const entry = new Date(entryTime);
  const exit = exitTime ? new Date(exitTime) : new Date();
  const durationMs = exit - entry;
  const durationHrs = durationMs / (1000 * 60 * 60);
  const durationMins = Math.floor((durationMs / 60000) % 60);
  const ai = getAIPrice(baseRate);
  const baseFare = ai.currentPrice * durationHrs;
  const gst = baseFare * 0.18;
  return {
    entryTime: entry.toISOString(),
    exitTime: exit.toISOString(),
    durationHrs: parseFloat(durationHrs.toFixed(2)),
    durationDisplay: `${Math.floor(durationHrs)}h ${durationMins}m`,
    baseRate: ai.currentPrice,
    baseFare: parseFloat(baseFare.toFixed(2)),
    gst: parseFloat(gst.toFixed(2)),
    total: parseFloat((baseFare + gst).toFixed(2)),
    aiPricing: ai
  };
}

// =============================
// ROUTES
// =============================

// ---- Health check ----
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' }));

// ---- FACILITIES ----
app.get('/api/facilities', (req, res) => {
  const enriched = db.facilities.map(f => {
    const slots = db.slots[f.id] || [];
    return {
      ...f,
      liveStats: {
        free: slots.filter(s => s.status === 'free').length,
        occupied: slots.filter(s => s.status === 'occupied').length,
        booked: slots.filter(s => s.status === 'booked').length,
        flagged: slots.filter(s => s.status === 'flagged').length,
        total: slots.length
      },
      aiPrice: getAIPrice(f.priceBase)
    };
  });
  res.json({ success: true, data: enriched });
});

app.get('/api/facilities/:id', (req, res) => {
  const facility = db.facilities.find(f => f.id === req.params.id);
  if (!facility) return res.status(404).json({ success: false, error: 'Facility not found' });
  const slots = db.slots[facility.id] || [];
  res.json({
    success: true,
    data: {
      ...facility,
      liveStats: {
        free: slots.filter(s => s.status === 'free').length,
        occupied: slots.filter(s => s.status === 'occupied').length,
        booked: slots.filter(s => s.status === 'booked').length,
        flagged: slots.filter(s => s.status === 'flagged').length,
        total: slots.length
      },
      aiPrice: getAIPrice(facility.priceBase)
    }
  });
});

// ---- SLOTS ----
app.get('/api/facilities/:id/slots', (req, res) => {
  const { zone, status } = req.query;
  let slots = db.slots[req.params.id] || [];
  if (zone) slots = slots.filter(s => s.zone === zone.toUpperCase());
  if (status) slots = slots.filter(s => s.status === status);
  res.json({ success: true, data: slots, count: slots.length });
});

app.get('/api/facilities/:fid/slots/:slotId', (req, res) => {
  const slots = db.slots[req.params.fid] || [];
  const slot = slots.find(s => s.id === req.params.slotId);
  if (!slot) return res.status(404).json({ success: false, error: 'Slot not found' });
  res.json({ success: true, data: slot });
});

// Simulate sensor update (vehicle entry/exit)
app.post('/api/facilities/:fid/slots/:slotId/sensor', (req, res) => {
  const { action, vehicleNum } = req.body; // action: 'enter' | 'exit'
  const slots = db.slots[req.params.fid] || [];
  const slot = slots.find(s => s.id === req.params.slotId);
  if (!slot) return res.status(404).json({ success: false, error: 'Slot not found' });
  if (action === 'enter') {
    slot.status = 'occupied';
    slot.vehicleNum = vehicleNum;
    slot.entryTime = new Date().toISOString();
  } else if (action === 'exit') {
    const bill = calculateBill(slot.entryTime, null, 40);
    slot.status = 'free';
    slot.vehicleNum = null;
    slot.entryTime = null;
    return res.json({ success: true, data: { slot, bill } });
  }
  res.json({ success: true, data: slot });
});

// ---- BOOKINGS ----
app.get('/api/bookings', (req, res) => {
  const { vehicle, status } = req.query;
  let bookings = db.bookings;
  if (vehicle) bookings = bookings.filter(b => b.vehicle.toLowerCase().includes(vehicle.toLowerCase()));
  if (status) bookings = bookings.filter(b => b.status === status);
  res.json({ success: true, data: bookings, count: bookings.length });
});

app.post('/api/bookings', (req, res) => {
  const { facilityId, slotId, vehicle, date, timeSlot, duration } = req.body;
  if (!facilityId || !slotId || !vehicle || !date) {
    return res.status(400).json({ success: false, error: 'facilityId, slotId, vehicle, date are required' });
  }
  const facility = db.facilities.find(f => f.id === facilityId);
  if (!facility) return res.status(404).json({ success: false, error: 'Facility not found' });
  const slots = db.slots[facilityId] || [];
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ success: false, error: 'Slot not found' });
  if (slot.status !== 'free') return res.status(409).json({ success: false, error: 'Slot is not available' });
  const ai = getAIPrice(facility.priceBase);
  const hrs = duration || 2;
  const baseFare = ai.currentPrice * hrs;
  const booking = {
    id: 'BK' + uuidv4().slice(0, 8).toUpperCase(),
    facilityId,
    facilityName: facility.name,
    slotId,
    vehicle,
    date,
    timeSlot: timeSlot || '10:00 – 12:00',
    duration: hrs,
    rate: ai.currentPrice,
    baseFare: parseFloat(baseFare.toFixed(2)),
    gst: parseFloat((baseFare * 0.18).toFixed(2)),
    total: parseFloat((baseFare * 1.18).toFixed(2)),
    status: 'upcoming',
    aiPricing: ai,
    createdAt: new Date().toISOString()
  };
  db.bookings.unshift(booking);
  slot.status = 'booked';
  slot.bookedBy = vehicle;
  res.status(201).json({ success: true, data: booking });
});

app.get('/api/bookings/:id', (req, res) => {
  const booking = db.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
  res.json({ success: true, data: booking });
});

app.patch('/api/bookings/:id/cancel', (req, res) => {
  const booking = db.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
  booking.status = 'cancelled';
  booking.cancelledAt = new Date().toISOString();
  // Free up slot
  const slots = db.slots[booking.facilityId] || [];
  const slot = slots.find(s => s.id === booking.slotId);
  if (slot && slot.status === 'booked') { slot.status = 'free'; slot.bookedBy = null; }
  res.json({ success: true, data: booking });
});

// ---- GPS TRACKING ----
app.get('/api/vehicles', (req, res) => {
  res.json({ success: true, data: db.vehicles, count: db.vehicles.length });
});

app.post('/api/vehicles/track', (req, res) => {
  const { vehicleNum, slotId, facilityId, lat, lng } = req.body;
  if (!vehicleNum) return res.status(400).json({ success: false, error: 'vehicleNum required' });
  let vehicle = db.vehicles.find(v => v.vehicleNum === vehicleNum);
  if (!vehicle) {
    vehicle = { id: uuidv4(), vehicleNum, slotId, facilityId, entryTime: new Date().toISOString(), status: 'active', flagged: false, positions: [] };
    db.vehicles.push(vehicle);
  }
  vehicle.lat = lat;
  vehicle.lng = lng;
  vehicle.lastSeen = new Date().toISOString();
  vehicle.positions.push({ lat, lng, timestamp: new Date().toISOString() });
  if (vehicle.positions.length > 100) vehicle.positions.shift(); // Keep last 100
  // Auto-flag if parked > 24 hours
  const hrs = (Date.now() - new Date(vehicle.entryTime)) / 3600000;
  if (hrs > 24) { vehicle.flagged = true; vehicle.status = 'flagged'; }
  res.json({ success: true, data: vehicle });
});

app.get('/api/vehicles/:vehicleNum', (req, res) => {
  const vehicle = db.vehicles.find(v => v.vehicleNum === req.params.vehicleNum);
  if (!vehicle) return res.status(404).json({ success: false, error: 'Vehicle not found' });
  res.json({ success: true, data: vehicle });
});

// ---- PAYMENT / BILLING ----
app.post('/api/billing/calculate', (req, res) => {
  const { entryTime, exitTime, baseRate, facilityId } = req.body;
  if (!entryTime) return res.status(400).json({ success: false, error: 'entryTime required' });
  const facility = facilityId ? db.facilities.find(f => f.id === facilityId) : null;
  const rate = baseRate || (facility ? facility.priceBase : 35);
  const bill = calculateBill(entryTime, exitTime, rate);
  res.json({ success: true, data: bill });
});

app.post('/api/payments', (req, res) => {
  const { bookingId, vehicleNum, slotId, facilityId, amount, method, entryTime } = req.body;
  if (!amount || !method) return res.status(400).json({ success: false, error: 'amount and method required' });
  const payment = {
    id: 'PAY' + uuidv4().slice(0, 8).toUpperCase(),
    bookingId,
    vehicleNum,
    slotId,
    facilityId,
    amount,
    method,
    status: 'success',
    receipt: 'REC-' + Date.now(),
    paidAt: new Date().toISOString()
  };
  db.payments.push(payment);
  // Update booking if linked
  if (bookingId) {
    const booking = db.bookings.find(b => b.id === bookingId);
    if (booking) booking.status = 'completed';
  }
  // Free up slot
  if (slotId && facilityId) {
    const slots = db.slots[facilityId] || [];
    const slot = slots.find(s => s.id === slotId);
    if (slot) { slot.status = 'free'; slot.vehicleNum = null; slot.entryTime = null; }
  }
  res.status(201).json({ success: true, data: payment });
});

app.get('/api/payments', (req, res) => {
  const { vehicleNum } = req.query;
  let payments = db.payments;
  if (vehicleNum) payments = payments.filter(p => p.vehicleNum === vehicleNum);
  res.json({ success: true, data: payments, count: payments.length });
});

// ---- AI ENGINE ----
app.get('/api/ai/pricing/:facilityId', (req, res) => {
  const facility = db.facilities.find(f => f.id === req.params.facilityId);
  if (!facility) return res.status(404).json({ success: false, error: 'Facility not found' });
  res.json({ success: true, data: getAIPrice(facility.priceBase) });
});

app.get('/api/ai/anomalies', (req, res) => {
  const anomalies = detectAnomalies();
  res.json({ success: true, data: anomalies, count: anomalies.length });
});

app.get('/api/ai/recommend/:facilityId', (req, res) => {
  const slots = db.slots[req.params.facilityId] || [];
  const freeSlots = slots.filter(s => s.status === 'free');
  if (!freeSlots.length) return res.json({ success: false, error: 'No free slots available' });
  // Recommend nearest to entrance (Zone A, lowest number)
  const sorted = freeSlots.sort((a, b) => {
    const zoneOrder = { A: 0, B: 1, C: 2 };
    if (zoneOrder[a.zone] !== zoneOrder[b.zone]) return zoneOrder[a.zone] - zoneOrder[b.zone];
    return parseInt(a.id.split('-')[1]) - parseInt(b.id.split('-')[1]);
  });
  res.json({ success: true, data: { recommended: sorted[0], alternatives: sorted.slice(1, 3) } });
});

// ---- 404 ----
app.use((req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`\n🚗 ParkIQ Backend running on http://localhost:${PORT}`);
  console.log(`📡 API docs: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
