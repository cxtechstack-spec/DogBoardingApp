// TEMPORARY diagnostic route — confirms whether GHL's file-upload-to-custom-field
// API works against a custom OBJECT record (not just Contacts), which the public
// docs don't render clearly. Creates a throwaway test Dog record, attempts a test
// file upload to its Vaccine File field, then deletes the test record. To be
// removed once confirmed either way — not part of the app's real functionality.
import { Router } from 'express';
import db from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';

const router = Router();
const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

router.get('/vaccine-file-upload-test', async (req, res) => {
  try {
    const locationId = req.query.location_id;
    const client = await db.client.findUnique({ where: { ghlLocationId: locationId } });
    if (!client) return res.status(404).json({ error: 'client not found' });
    const token = decrypt(client.ghlApiTokenEncrypted);
    const objectKey = client.dogObjectKey;

    const headers = { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' };

    const fieldsRes = await fetch(`${BASE_URL}/objects/${objectKey}?locationId=${locationId}`, { headers });
    const fieldsData = await fieldsRes.json();
    const allFields = (fieldsData.fields || []).map((f) => ({ id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType }));
    const vaccineFileField = (fieldsData.fields || []).find((f) => f.dataType === 'FILE_UPLOAD');

    const createRes = await fetch(`${BASE_URL}/objects/${objectKey}/records`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, properties: { [client.dogNameFieldKey]: '___API_TEST___' } }),
    });
    const createData = await createRes.json();
    const record = createData.record ?? createData;

    let uploadResult = null;
    if (vaccineFileField && record?.id) {
      const form = new FormData();
      // Minimal valid 1x1 transparent PNG — the field only accepts pdf/doc/xls/csv/jpeg/jpg/png/gif.
      const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const blob = new Blob([pngBytes], { type: 'image/png' });
      form.append(`${vaccineFileField.id}_debugtest123`, blob, 'test.png');
      form.append('id', record.id);
      form.append('maxFiles', '1');

      const uploadRes = await fetch(`${BASE_URL}/locations/${locationId}/customFields/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Version: API_VERSION },
        body: form,
      });
      const uploadText = await uploadRes.text();
      uploadResult = { status: uploadRes.status, body: uploadText };

      // Re-fetch the record to see if the field actually got set.
      const recheckRes = await fetch(`${BASE_URL}/objects/${objectKey}/records/${record.id}?locationId=${locationId}`, { headers });
      const recheckData = await recheckRes.json();
      uploadResult.recheckRecord = recheckData.record ?? recheckData;
    }

    let deleteResult = null;
    if (record?.id) {
      const delRes = await fetch(`${BASE_URL}/objects/${objectKey}/records/${record.id}`, {
        method: 'DELETE',
        headers,
      });
      const delText = await delRes.text();
      deleteResult = { status: delRes.status, body: delText };
    }

    res.json({ objectKey, allFields, vaccineFileField, createStatus: createRes.status, record, uploadResult, deleteResult });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// One-off cleanup for a record orphaned by an earlier DELETE bug in this file.
router.get('/cleanup-record', async (req, res) => {
  try {
    const locationId = req.query.location_id;
    const recordId = req.query.recordId;
    const client = await db.client.findUnique({ where: { ghlLocationId: locationId } });
    if (!client) return res.status(404).json({ error: 'client not found' });
    const token = decrypt(client.ghlApiTokenEncrypted);
    const headers = { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' };

    const delRes = await fetch(`${BASE_URL}/objects/${client.dogObjectKey}/records/${recordId}`, {
      method: 'DELETE',
      headers,
    });
    const delText = await delRes.text();
    res.json({ status: delRes.status, body: delText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
