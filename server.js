import 'dotenv/config';
import express from 'express';
import settingsRouter from './routes/settings.js';
import bookingsRouter from './routes/bookings.js';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use('/api/settings', settingsRouter);
app.use('/api/bookings', bookingsRouter);

// Catches errors forwarded by asyncHandler (or thrown synchronously in any
// route) so a single bad request returns a 500 response instead of crashing
// the whole server. Routes can throw with a `statusCode` property to control
// the response status; anything else defaults to 500.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
