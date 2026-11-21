import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

import { AppError, ErrorCode } from '../src/core/errors.js';
import {
  extractRecipientRowsFromFile,
  extractRecipientsFromFile,
  extractRecipientTableFromFile,
} from '../src/modules/campaign/recipient-file.js';
import {
  CampaignStatus,
  DEFAULT_NAME_FALLBACK,
  extractPlaceholders,
  hasNamePlaceholder,
  isWithinWindow,
  normalizeToE164,
  normalizeVarKey,
  parseNamedRecipients,
  parseRecipients,
  PausedBy,
  RecipientStatus,
  renderBody,
  renderTemplate,
  toPublicCampaign,
  worstCaseBody,
  type Campaign,
} from '../src/domain/campaign.js';
import { type Message, MessageStatus } from '../src/domain/message.js';
import { campaignService } from '../src/modules/campaign/campaign.service.js';
import { __test, stepCampaign, tryResume, type RunnerDeps } from '../src/modules/campaign/campaign.runner.js';
import { repositories, resetRepositories } from '../src/repositories/index.js';
import type { SendResult } from '../src/modules/sms/sms.service.js';

/**
 * Campaigns: the bulk / promotional path.
 *
 * Three layers, three concerns:
 *   1. Number normalisation - the messy paste in, clean E.164 out.
 *   2. The service - creation, validation, and the operator lifecycle.
 *   3. The runner - the paced state machine, driven with a fake clock and a fake
 *      sender so we test the branching, not the wall clock or the radio.
 */

beforeEach(() => {
  resetRepositories();
});

// ---------------------------------------------------------------------------
describe('normalizeToE164', () => {
  it('prefixes a bare local number with the chosen country code', () => {
    expect(normalizeToE164('9876543210', '+91')).toBe('+919876543210');
  });

  it('strips a national trunk zero before prefixing', () => {
    expect(normalizeToE164('09876543210', '+91')).toBe('+919876543210');
  });

  it('leaves a number already in +CC form untouched', () => {
    expect(normalizeToE164('+14155552671', '+91')).toBe('+14155552671');
  });

  it('ignores human punctuation - spaces, dashes, brackets', () => {
    expect(normalizeToE164(' (98765) 43210 ', '+91')).toBe('+919876543210');
  });

  it('rejects a number too short to be routable', () => {
    expect(normalizeToE164('12345', '+91')).toBeNull();
  });

  it('rejects letters', () => {
    expect(normalizeToE164('not-a-number', '+91')).toBeNull();
  });
});

describe('extractRecipientsFromFile', () => {
  it('pulls phone-like tokens out of a CSV, ignoring headers and non-numbers', async () => {
    const csv = 'Name,Phone\nAlice,9876543210\nBob,+919123456780\nNote,call me later\nPin,605001\n';
    const numbers = await extractRecipientsFromFile(Buffer.from(csv, 'utf8'), 'contacts.csv');

    expect(numbers).toContain('9876543210');
    expect(numbers).toContain('+919123456780');
    expect(numbers).not.toContain('605001'); // 6-digit pincode, too short to be a phone
    expect(numbers).not.toContain('Phone');
  });

  it('reads an .xlsx - numbers stored as text AND as Excel numbers, across columns', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['Name', 'Phone']);
    ws.addRow(['Alice', '+919876543210']); // text
    ws.addRow(['Bob', 9123456780]); // stored as a number
    ws.addRow(['Carol', '98765 43211']); // spaced text
    ws.addRow(['Note', 'no number here']);
    ws.addRow(['Pincode', 605001]); // too short
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const numbers = await extractRecipientsFromFile(buffer, 'contacts.xlsx');

    expect(numbers).toContain('+919876543210');
    expect(numbers).toContain('9123456780');
    expect(numbers).toContain('9876543211'); // the spaces were stripped
    expect(numbers).not.toContain('605001');
    // De-duplicated: the text/value double-read must not double-count.
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('rejects a file type it cannot read', async () => {
    await expect(extractRecipientsFromFile(Buffer.from('x'), 'contacts.pdf')).rejects.toThrow(/\.xlsx.*\.csv/i);
  });
});

describe('parseRecipients', () => {
  it('splits on newlines, commas and spaces', () => {
    const { valid } = parseRecipients('9876543210\n9123456780, 9000000001', '+91');
    expect(valid).toEqual(['+919876543210', '+919123456780', '+919000000001']);
  });

  it('de-duplicates, counting the drops - texting one person twice is how you get reported', () => {
    const { valid, duplicates } = parseRecipients('9876543210\n9876543210\n+919876543210', '+91');
    expect(valid).toEqual(['+919876543210']);
    expect(duplicates).toBe(2);
  });

  it('returns the invalid tokens rather than swallowing them', () => {
    const { valid, invalid } = parseRecipients('9876543210\ngarbage\n12', '+91');
    expect(valid).toEqual(['+919876543210']);
    expect(invalid).toEqual(['garbage', '12']);
  });
});

describe('renderBody - the {name} placeholder', () => {
  it('fills {name} with the recipient name', () => {
    expect(renderBody('Hi {name}, this is test', 'Sharvesh')).toBe('Hi Sharvesh, this is test');
  });

  it('falls back to a neutral word when the name is missing', () => {
    expect(renderBody('Hi {name}, this is test', null)).toBe(`Hi ${DEFAULT_NAME_FALLBACK}, this is test`);
    expect(renderBody('Hi {name}', '   ')).toBe(`Hi ${DEFAULT_NAME_FALLBACK}`);
  });

  it('is case-insensitive, tolerates inner spaces, and replaces every occurrence', () => {
    expect(renderBody('{ NAME } and {name}', 'Bala')).toBe('Bala and Bala');
  });

  it('truncates a name longer than 8 characters', () => {
    expect(renderBody('hi {name}', 'Balasubramanian')).toBe('hi Balasubr');
    expect(renderBody('hi {name}', 'Sharvesh')).toBe('hi Sharvesh'); // exactly 8 - untouched
  });

  it('does not leave a trailing space when the 8-char cut lands on a space', () => {
    // "Bala Ram Kumar" -> first 8 is "Bala Ram", which is fine; "Balasub Kumar" -> "Balasub"
    expect(renderBody('hi {name}', 'Balasub Kumar')).toBe('hi Balasub');
  });

  it('leaves a body with no placeholder untouched', () => {
    expect(renderBody('Flat 20% off', 'Sharvesh')).toBe('Flat 20% off');
  });

  it('hasNamePlaceholder detects the token', () => {
    expect(hasNamePlaceholder('Hi {name}')).toBe(true);
    expect(hasNamePlaceholder('Hi there')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('normalizeVarKey', () => {
  it('folds a spreadsheet header onto a variable key', () => {
    expect(normalizeVarKey('Due Date')).toBe('due_date');
    expect(normalizeVarKey('  AMOUNT  ')).toBe('amount');
    expect(normalizeVarKey('Flat-No.')).toBe('flat_no');
  });

  it('returns empty for a header with nothing usable in it', () => {
    expect(normalizeVarKey('')).toBe('');
    expect(normalizeVarKey('###')).toBe('');
    expect(normalizeVarKey(null)).toBe('');
  });
});

describe('extractPlaceholders', () => {
  it('lists the variables a body uses, normalised and de-duplicated in order', () => {
    expect(extractPlaceholders('Hi {name}, your rent {amount} is due {Due Date}. Thanks {name}!')).toEqual([
      'name',
      'amount',
      'due_date',
    ]);
  });

  it('treats {due date}, {Due_Date} and {DUE-DATE} as the same variable', () => {
    expect(extractPlaceholders('{due date} {Due_Date} {DUE-DATE}')).toEqual(['due_date']);
  });

  it('finds nothing in a body with no braces', () => {
    expect(extractPlaceholders('Flat 20% off this week')).toEqual([]);
  });
});

describe('renderTemplate - any number of variables', () => {
  it('fills every variable from the recipient row', () => {
    const { body, missing } = renderTemplate('Hi {name}, rent {amount} is due on {due_date}.', {
      name: 'Asha',
      amount: 'Rs 12,000',
      due_date: '5 Sep',
    });
    expect(body).toBe('Hi Asha, rent Rs 12,000 is due on 5 Sep.');
    expect(missing).toEqual([]);
  });

  it('matches a placeholder however it was typed', () => {
    const { body } = renderTemplate('{ Due Date } / {due_date} / {DUE-DATE}', { due_date: '5 Sep' });
    expect(body).toBe('5 Sep / 5 Sep / 5 Sep');
  });

  it('reports a variable this row has no value for, and leaves it unfilled', () => {
    const { body, missing } = renderTemplate('Rent {amount} due {due_date}', { amount: 'Rs 900' });
    expect(missing).toEqual(['due_date']);
    // Still a placeholder - the runner refuses to send this rather than mangling it.
    expect(body).toBe('Rent Rs 900 due {due_date}');
  });

  it('never reports {name} as missing - it has a fallback', () => {
    const { body, missing } = renderTemplate('Hi {name}', {});
    expect(body).toBe(`Hi ${DEFAULT_NAME_FALLBACK}`);
    expect(missing).toEqual([]);
  });

  it('keeps a long value that is not a name - truncating an amount would be wrong information', () => {
    const address = '12A Second Cross Street, Lawspet, Puducherry 605008';
    const { body } = renderTemplate('Site: {address}', { address });
    expect(body).toBe(`Site: ${address}`);
  });
});

describe('worstCaseBody', () => {
  it('segments against the longest value any recipient supplies', () => {
    const body = worstCaseBody('Rent {amount} due', [
      { vars: { amount: 'Rs 900' } },
      { vars: { amount: 'Rs 1,25,000' } },
      { vars: {} },
    ]);
    expect(body).toBe('Rent Rs 1,25,000 due');
  });

  it('uses the fallback for a name nobody supplies', () => {
    expect(worstCaseBody('Hi {name}', [{ vars: {} }])).toBe(`Hi ${DEFAULT_NAME_FALLBACK}`);
  });
});

describe('parseNamedRecipients', () => {
  it('normalises named rows and keeps the name attached', () => {
    const { valid } = parseNamedRecipients('', [{ phone: '9876543210', name: 'Sharvesh' }], '+91');
    expect(valid).toEqual([{ to: '+919876543210', name: 'Sharvesh', vars: { name: 'Sharvesh' } }]);
  });

  it('carries every mapped column through as a template variable', () => {
    const { valid } = parseNamedRecipients(
      '',
      [{ phone: '9876543210', vars: { Name: 'Asha', 'Due Date': '5th', amount: '12,000' } }],
      '+91',
    );
    // Keys are normalised, so a "Due Date" header backs {due_date} in the body.
    expect(valid).toEqual([
      {
        to: '+919876543210',
        name: 'Asha',
        vars: { name: 'Asha', due_date: '5th', amount: '12,000' },
      },
    ]);
  });

  it('drops blank cells rather than storing them as empty variables', () => {
    const { valid } = parseNamedRecipients('', [{ phone: '9876543210', vars: { amount: '   ', ref: 'R1' } }], '+91');
    expect(valid[0]?.vars).toEqual({ ref: 'R1' });
  });

  it('merges a nameless paste with named rows, the named copy winning on a clash', () => {
    const { valid, duplicates } = parseNamedRecipients(
      '9876543210\n9123456780',
      [{ phone: '9876543210', name: 'Sharvesh' }],
      '+91',
    );
    // Same number in both: the file (with a name) wins; the paste copy is the dup.
    expect(valid).toEqual([
      { to: '+919876543210', name: 'Sharvesh', vars: { name: 'Sharvesh' } },
      { to: '+919123456780', name: null, vars: {} },
    ]);
    expect(duplicates).toBe(1);
  });

  it('collects rows whose number cannot be normalised', () => {
    const { valid, invalid } = parseNamedRecipients('', [{ phone: 'not-a-number', name: 'X' }], '+91');
    expect(valid).toEqual([]);
    expect(invalid).toEqual(['not-a-number']);
  });
});

describe('extractRecipientRowsFromFile', () => {
  it('pairs each name with its number from a CSV, skipping non-number rows', async () => {
    const csv = 'Name,Phone\nAlice,9876543210\nBob,+919123456780\nNote,call me later\nPin,605001\n';
    const rows = await extractRecipientRowsFromFile(Buffer.from(csv, 'utf8'), 'contacts.csv');

    expect(rows).toEqual([
      { name: 'Alice', phone: '9876543210' },
      { name: 'Bob', phone: '+919123456780' },
    ]);
  });

  it('reads an .xlsx, pairing names with numbers stored as text OR as Excel numbers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['Name', 'Phone']);
    ws.addRow(['Alice', '+919876543210']); // text
    ws.addRow(['Bob', 9123456780]); // stored as a number
    ws.addRow(['Carol', '98765 43211']); // spaced text
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const rows = await extractRecipientRowsFromFile(buffer, 'contacts.xlsx');

    expect(rows).toEqual([
      { name: 'Alice', phone: '+919876543210' },
      { name: 'Bob', phone: '9123456780' },
      { name: 'Carol', phone: '9876543211' }, // spaces stripped
    ]);
  });

  it('falls back to nameless numbers when there is no name column', async () => {
    const csv = '9876543210\n9123456780\n';
    const rows = await extractRecipientRowsFromFile(Buffer.from(csv, 'utf8'), 'numbers.csv');

    expect(rows).toEqual([
      { name: null, phone: '9876543210' },
      { name: null, phone: '9123456780' },
    ]);
  });
});

describe('extractRecipientTableFromFile', () => {
  it('reads every column of a CSV, guessing the phone column and naming the variables', async () => {
    const csv = 'Name,Phone,Rent Amount,Due Date\nAlice,9876543210,12000,5 Sep\nBob,9123456780,9500,7 Sep\n';
    const table = await extractRecipientTableFromFile(Buffer.from(csv, 'utf8'), 'rent.csv');

    expect(table.headerPresent).toBe(true);
    expect(table.phoneColumn).toBe(1);
    expect(table.columns.map((c) => c.key)).toEqual(['name', 'phone', 'rent_amount', 'due_date']);
    expect(table.columns.map((c) => c.role)).toEqual(['variable', 'phone', 'variable', 'variable']);
    expect(table.columns[2]?.sample).toBe('12000');
    expect(table.rows).toEqual([
      ['Alice', '9876543210', '12000', '5 Sep'],
      ['Bob', '9123456780', '9500', '7 Sep'],
    ]);
  });

  it('reads an .xlsx the same way, whatever order the columns are in', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rent');
    ws.addRow(['Amount', 'Mobile', 'Flat']);
    ws.addRow([12000, '9876543210', 'A-12']);
    ws.addRow([9500, 9123456780, 'B-04']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const table = await extractRecipientTableFromFile(buffer, 'rent.xlsx');

    expect(table.phoneColumn).toBe(1);
    expect(table.columns.map((c) => c.key)).toEqual(['amount', 'mobile', 'flat']);
    expect(table.rows).toEqual([
      ['12000', '9876543210', 'A-12'],
      ['9500', '9123456780', 'B-04'],
    ]);
  });

  it('counts the rows with no number instead of quietly shrinking the list', async () => {
    const csv = 'Name,Phone\nAlice,9876543210\nTotal,\nNote,call me later\n';
    const table = await extractRecipientTableFromFile(Buffer.from(csv, 'utf8'), 'rent.csv');

    expect(table.rows).toHaveLength(1);
    expect(table.skipped).toBe(2);
  });

  it('labels the columns when the sheet has no header row', async () => {
    const csv = '9876543210,12000\n9123456780,9500\n';
    const table = await extractRecipientTableFromFile(Buffer.from(csv, 'utf8'), 'rent.csv');

    expect(table.headerPresent).toBe(false);
    expect(table.columns.map((c) => c.header)).toEqual(['Column A', 'Column B']);
    expect(table.rows).toHaveLength(2);
  });

  it('makes duplicate headers unique, so two "Name" columns cannot both claim {name}', async () => {
    const csv = 'Name,Phone,Name\nAlice,9876543210,Owner\n';
    const table = await extractRecipientTableFromFile(Buffer.from(csv, 'utf8'), 'rent.csv');

    expect(table.columns.map((c) => c.key)).toEqual(['name', 'phone', 'name_2']);
  });

  it('stops at maxRows and says it truncated', async () => {
    const csv = 'Phone\n9876543210\n9123456780\n9000000001\n';
    const table = await extractRecipientTableFromFile(Buffer.from(csv, 'utf8'), 'rent.csv', { maxRows: 2 });

    expect(table.rows).toHaveLength(2);
    expect(table.truncated).toBe(true);
  });

  it('rejects a file it cannot read', async () => {
    await expect(extractRecipientTableFromFile(Buffer.from('x'), 'rent.pdf')).rejects.toThrow(/\.xlsx.*\.csv/i);
  });
});

describe('isWithinWindow', () => {
  it('is inside a normal daytime window, with an exclusive end hour', () => {
    expect(isWithinWindow(9, 9, 18)).toBe(true); // start is inclusive
    expect(isWithinWindow(17, 9, 18)).toBe(true);
    expect(isWithinWindow(18, 9, 18)).toBe(false); // end is exclusive - "stops at 18:00"
    expect(isWithinWindow(8, 9, 18)).toBe(false);
    expect(isWithinWindow(3, 9, 18)).toBe(false);
  });

  it('covers the whole day with 0-24', () => {
    for (let h = 0; h < 24; h += 1) expect(isWithinWindow(h, 0, 24)).toBe(true);
  });

  it('wraps past midnight for an overnight window', () => {
    expect(isWithinWindow(23, 22, 6)).toBe(true);
    expect(isWithinWindow(2, 22, 6)).toBe(true);
    expect(isWithinWindow(6, 22, 6)).toBe(false);
    expect(isWithinWindow(12, 22, 6)).toBe(false);
  });
});

describe('toPublicCampaign', () => {
  const base: Campaign = {
    id: 'c1',
    userId: 'u1',
    name: 'Promo',
    body: 'hi',
    from: null,
    intervalMs: 15_000,
    windowStartHour: 9,
    windowEndHour: 18,
    status: CampaignStatus.RUNNING,
    recipients: [
      {
        to: '+911',
        name: 'Asha',
        vars: { name: 'Asha' },
        status: RecipientStatus.SENT,
        messageId: 'm',
        error: null,
        sentAt: new Date(),
      },
      {
        to: '+912',
        name: null,
        vars: {},
        status: RecipientStatus.PENDING,
        messageId: null,
        error: null,
        sentAt: null,
      },
      {
        to: '+913',
        name: null,
        vars: {},
        status: RecipientStatus.PENDING,
        messageId: null,
        error: null,
        sentAt: null,
      },
    ],
    partCount: 1,
    isUnicode: false,
    sentCount: 1,
    failedCount: 0,
    pausedReason: null,
    pausedBy: null,
    lastSendAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('reports interval in seconds and derives the pending count', () => {
    const pub = toPublicCampaign(base);
    expect(pub.intervalSeconds).toBe(15);
    expect(pub.total).toBe(3);
    expect(pub.pendingCount).toBe(2);
  });

  it('omits the recipient list by default and includes it on request', () => {
    expect(toPublicCampaign(base).recipients).toBeUndefined();
    expect(toPublicCampaign(base, { includeRecipients: true }).recipients).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
describe('campaignService.create', () => {
  const baseParams = {
    userId: 'u1',
    name: 'Diwali offer',
    body: 'Flat 20% off',
    from: null,
    countryCode: '+91',
    start: false,
  };

  it('parses, normalises and reports what it skipped', async () => {
    const result = await campaignService.create({
      ...baseParams,
      recipients: '9876543210\n9876543210\ngarbage',
    });

    expect(result.campaign.recipients.map((r) => r.to)).toEqual(['+919876543210']);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toEqual(['garbage']);
    expect(result.campaign.status).toBe(CampaignStatus.DRAFT);
  });

  it('clamps the pace up to the safety floor - a SIM-saving minimum, not a preference', async () => {
    const result = await campaignService.create({
      ...baseParams,
      recipients: '9876543210',
      intervalSeconds: 1, // 1s requested, below the 3s floor
    });

    expect(result.campaign.intervalMs).toBeGreaterThanOrEqual(3_000);
  });

  it('refuses a list with no valid numbers', async () => {
    await expect(campaignService.create({ ...baseParams, recipients: 'garbage, nonsense' })).rejects.toThrow(
      /no valid phone numbers/i,
    );
  });

  it('starts immediately when asked, moving the campaign to RUNNING', async () => {
    const result = await campaignService.create({
      ...baseParams,
      recipients: '9876543210',
      start: true,
    });

    expect(result.campaign.status).toBe(CampaignStatus.RUNNING);
    expect(result.campaign.startedAt).not.toBeNull();
  });
});

describe('campaignService lifecycle', () => {
  async function draft(userId = 'u1') {
    const { campaign } = await campaignService.create({
      userId,
      name: 'C',
      body: 'hi',
      from: null,
      recipients: '9876543210\n9123456780',
      countryCode: '+91',
      start: false,
    });
    return campaign;
  }

  it('start then pause then resume', async () => {
    const c = await draft();

    const running = await campaignService.start('u1', c.id);
    expect(running.status).toBe(CampaignStatus.RUNNING);

    const paused = await campaignService.pause('u1', c.id);
    expect(paused.status).toBe(CampaignStatus.PAUSED);

    const resumed = await campaignService.start('u1', c.id);
    expect(resumed.status).toBe(CampaignStatus.RUNNING);
    expect(resumed.pausedReason).toBeNull();
  });

  it('start is idempotent while running', async () => {
    const c = await draft();
    await campaignService.start('u1', c.id);
    const again = await campaignService.start('u1', c.id);
    expect(again.status).toBe(CampaignStatus.RUNNING);
  });

  it('a cancelled campaign cannot be started again', async () => {
    const c = await draft();
    await campaignService.cancel('u1', c.id);
    await expect(campaignService.start('u1', c.id)).rejects.toThrow(/cannot be started/i);
  });

  it("refuses to act on another user's campaign - 404, not 403", async () => {
    const c = await draft('owner');
    await expect(campaignService.start('intruder', c.id)).rejects.toThrow(/not found/i);
    expect(await campaignService.findForUser('intruder', c.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('campaign runner - stepCampaign', () => {
  /** A running campaign with `count` PENDING recipients, plus a clock anchor. */
  async function runningCampaign(count = 2): Promise<Campaign> {
    const recipients = Array.from({ length: count }, (_, i) => `98765432${String(10 + i).padStart(2, '0')}`).join('\n');
    const { campaign } = await campaignService.create({
      userId: 'u1',
      name: 'Blast',
      body: 'hi',
      from: null,
      recipients,
      countryCode: '+91',
      start: true,
    });
    return campaign;
  }

  const T0 = 1_000_000_000_000;

  function deps(send: RunnerDeps['send'], now = T0, hour = 12, canSend = true): RunnerDeps {
    // Default hour 12 is inside the default 9-18 window, so existing tests send.
    return { send, now: () => now, currentHour: () => hour, canSend: () => Promise.resolve(canSend) };
  }

  const dispatched = (id: string): Promise<SendResult> =>
    Promise.resolve({ message: { id } as unknown as Message, dispatched: true });

  async function reload(id: string): Promise<Campaign> {
    const c = await repositories().campaigns.findById(id);
    if (!c) throw new Error('campaign vanished');
    return c;
  }

  it('does nothing when the interval has not elapsed', async () => {
    const c = await runningCampaign();
    // Pretend we just sent one, 1s ago, with a 10s interval.
    await repositories().campaigns.update(c.id, { lastSendAt: new Date(T0 - 1_000) });
    const fresh = await reload(c.id);

    let calls = 0;
    await stepCampaign(
      fresh,
      deps(() => {
        calls += 1;
        return dispatched('x');
      }, T0),
    );

    expect(calls).toBe(0);
  });

  it('dispatches the next recipient and advances the counter when due', async () => {
    const c = await runningCampaign(2);

    await stepCampaign(
      c,
      deps((p) => dispatched('msg-' + p.recipient), T0),
    );

    const after = await reload(c.id);
    expect(after.sentCount).toBe(1);
    expect(after.recipients[0]).toMatchObject({ status: RecipientStatus.SENT, messageId: 'msg-+919876543210' });
    expect(after.recipients[1]?.status).toBe(RecipientStatus.PENDING);
    expect(after.lastSendAt).not.toBeNull();
  });

  it('pauses - not floods the queue - when no phone is connected', async () => {
    const c = await runningCampaign(3);

    // dispatched:false is exactly what smsService.send returns when the message
    // was accepted but every phone is offline.
    await stepCampaign(
      c,
      deps(() => Promise.resolve({ message: { id: 'q' } as unknown as Message, dispatched: false }), T0),
    );

    const after = await reload(c.id);
    expect(after.status).toBe(CampaignStatus.PAUSED);
    expect(after.pausedReason).toMatch(/no gateway/i);
    // The recipient stays PENDING so a resume re-sends it - nothing was dumped.
    expect(after.recipients.every((r) => r.status === RecipientStatus.PENDING)).toBe(true);
    expect(after.sentCount).toBe(0);
  });

  it('withdraws the queued message when it pauses, so a resume cannot deliver it twice', async () => {
    const c = await runningCampaign(2);

    // A real message row, exactly as smsService.send would have left it: accepted,
    // QUEUED, waiting for a phone that is not there.
    const queued = await repositories().messages.create({
      userId: 'u1',
      recipient: '+919876543210',
      body: 'hi',
      partCount: 1,
      isUnicode: false,
      clientRef: `campaign:${c.id}`,
    });

    await stepCampaign(
      c,
      deps(() => Promise.resolve({ message: queued, dispatched: false }), T0),
    );

    // The bug this guards against: the message stays QUEUED, the next phone to
    // connect drains it from the backlog, AND the resume sends the recipient a
    // second copy - two message rows, one very annoyed stranger.
    const after = await repositories().messages.findById(queued.id);
    expect(after?.status).toBe(MessageStatus.CANCELLED);

    const campaign = await reload(c.id);
    expect(campaign.status).toBe(CampaignStatus.PAUSED);
    expect(campaign.recipients[0]?.status).toBe(RecipientStatus.PENDING);
  });

  it('still pauses when the queued message cannot be withdrawn', async () => {
    const c = await runningCampaign(2);

    // The withdrawal targets a message that is not there. Pausing is what stops
    // the whole list being dumped into the backlog, so it must happen anyway.
    await stepCampaign(
      c,
      deps(() => Promise.resolve({ message: { id: 'gone' } as unknown as Message, dispatched: false }), T0),
    );

    const campaign = await reload(c.id);
    expect(campaign.status).toBe(CampaignStatus.PAUSED);
    expect(campaign.sentCount).toBe(0);
  });

  it('pauses on a recoverable send failure (every SIM at its cap)', async () => {
    const c = await runningCampaign(2);

    await stepCampaign(
      c,
      deps(() =>
        Promise.reject(new AppError('All SIMs exhausted', { statusCode: 429, code: ErrorCode.DAILY_LIMIT_EXCEEDED })),
      ),
    );

    const after = await reload(c.id);
    expect(after.status).toBe(CampaignStatus.PAUSED);
    expect(after.recipients[0]?.status).toBe(RecipientStatus.PENDING); // retried on resume
    expect(after.sentCount).toBe(0);
  });

  describe('auto-resume', () => {
    /** Park a campaign the way the runner does, then hand it back. */
    async function systemPaused(reason = 'No gateway phone is connected.'): Promise<Campaign> {
      const c = await runningCampaign(3);
      await repositories().campaigns.update(c.id, {
        status: CampaignStatus.PAUSED,
        pausedReason: reason,
        pausedBy: PausedBy.SYSTEM,
      });
      __test.lastProbeAt.clear(); // no probe has happened for this fresh id
      return reload(c.id);
    }

    it('resumes a system-paused campaign once a send would succeed again', async () => {
      const c = await systemPaused();

      await tryResume(c, deps(() => dispatched('x'), T0, 12, true));

      const after = await reload(c.id);
      expect(after.status).toBe(CampaignStatus.RUNNING);
      expect(after.pausedReason).toBeNull();
      expect(after.pausedBy).toBeNull();
    });

    it('leaves it paused while the blocker is still there', async () => {
      const c = await systemPaused();

      await tryResume(c, deps(() => dispatched('x'), T0, 12, false));

      const after = await reload(c.id);
      expect(after.status).toBe(CampaignStatus.PAUSED);
      expect(after.pausedBy).toBe(PausedBy.SYSTEM);
    });

    it('never resumes an operator pause, however healthy the fleet is', async () => {
      const c = await runningCampaign(3);
      await campaignService.pause('u1', c.id);
      const paused = await reload(c.id);
      expect(paused.pausedBy).toBe(PausedBy.OPERATOR);

      await tryResume(paused, deps(() => dispatched('x'), T0, 12, true));

      const after = await reload(c.id);
      expect(after.status).toBe(CampaignStatus.PAUSED);
    });

    it('never resumes a pause from before pausedBy existed', async () => {
      const c = await runningCampaign(3);
      // A legacy document: PAUSED, with a reason, but no idea who set it.
      await repositories().campaigns.update(c.id, {
        status: CampaignStatus.PAUSED,
        pausedReason: 'No gateway phone is connected.',
        pausedBy: null,
      });

      await tryResume(await reload(c.id), deps(() => dispatched('x'), T0, 12, true));

      expect((await reload(c.id)).status).toBe(CampaignStatus.PAUSED);
    });

    it('does not re-probe until the backoff has elapsed', async () => {
      const c = await systemPaused();

      let probes = 0;
      const counting = (now: number, ok: boolean): RunnerDeps => ({
        send: () => dispatched('x'),
        now: () => now,
        currentHour: () => 12,
        canSend: () => {
          probes += 1;
          return Promise.resolve(ok);
        },
      });

      await tryResume(c, counting(T0, false)); // probes, still blocked
      await tryResume(c, counting(T0 + 1_000, true)); // too soon - must not probe
      expect(probes).toBe(1);
      expect((await reload(c.id)).status).toBe(CampaignStatus.PAUSED);

      // Past the backoff, and now a send would work.
      await tryResume(c, counting(T0 + 31_000, true));
      expect(probes).toBe(2);
      expect((await reload(c.id)).status).toBe(CampaignStatus.RUNNING);
    });

    it('does not resume a campaign an operator paused since the snapshot was taken', async () => {
      const c = await systemPaused();
      // The snapshot `c` says SYSTEM; the operator has since pressed pause for real.
      await repositories().campaigns.update(c.id, { pausedBy: PausedBy.OPERATOR, pausedReason: 'Paused by you.' });

      await tryResume(c, deps(() => dispatched('x'), T0, 12, true));

      expect((await reload(c.id)).status).toBe(CampaignStatus.PAUSED);
    });

    it('resuming does not send anything by itself - the next tick does, at pace', async () => {
      const c = await systemPaused();

      let calls = 0;
      await tryResume(c, {
        send: () => {
          calls += 1;
          return dispatched('x');
        },
        now: () => T0,
        currentHour: () => 12,
        canSend: () => Promise.resolve(true),
      });

      expect(calls).toBe(0);
      expect((await reload(c.id)).status).toBe(CampaignStatus.RUNNING);
    });

    it('stamps SYSTEM when the runner parks it, so the pause it just made is resumable', async () => {
      const c = await runningCampaign(2);

      await stepCampaign(
        c,
        deps(() =>
          Promise.reject(
            new AppError('All SIMs exhausted', { statusCode: 429, code: ErrorCode.DAILY_LIMIT_EXCEEDED }),
          ),
        ),
      );

      const after = await reload(c.id);
      expect(after.status).toBe(CampaignStatus.PAUSED);
      expect(after.pausedBy).toBe(PausedBy.SYSTEM);
    });
  });

  it('marks one recipient FAILED on an unexpected error and keeps the campaign running', async () => {
    const c = await runningCampaign(2);

    await stepCampaign(
      c,
      deps(() => Promise.reject(new Error('bizarre one-off'))),
    );

    const after = await reload(c.id);
    expect(after.status).toBe(CampaignStatus.RUNNING); // NOT paused - one bad number
    expect(after.failedCount).toBe(1);
    expect(after.recipients[0]?.status).toBe(RecipientStatus.FAILED);
    expect(after.recipients[0]?.error).toMatch(/bizarre/);
  });

  it('completes the campaign once every recipient is processed', async () => {
    const c = await runningCampaign(1);

    // First step: send the only recipient (now = T0).
    await stepCampaign(
      c,
      deps((p) => dispatched(p.recipient), T0),
    );
    // Second step, well past the interval: no PENDING left -> COMPLETED.
    const mid = await reload(c.id);
    await stepCampaign(
      mid,
      deps((p) => dispatched(p.recipient), T0 + 60_000),
    );

    const done = await reload(c.id);
    expect(done.status).toBe(CampaignStatus.COMPLETED);
    expect(done.completedAt).not.toBeNull();
    expect(done.sentCount).toBe(1);
  });

  it('does not send outside the business-hours window, and resumes when it reopens', async () => {
    const c = await runningCampaign(2); // default window 09-18 (from env)
    let calls = 0;
    const send = () => {
      calls += 1;
      return dispatched('x');
    };

    // 03:00 - outside the window. The campaign stays RUNNING but sends nothing.
    await stepCampaign(c, deps(send, T0, 3));
    expect(calls).toBe(0);
    expect((await reload(c.id)).status).toBe(CampaignStatus.RUNNING);

    // 10:00 - window is open. Now it sends.
    await stepCampaign(await reload(c.id), deps(send, T0, 10));
    expect(calls).toBe(1);
  });

  it('does not send for a campaign paused out from under it', async () => {
    const c = await runningCampaign(2);
    await repositories().campaigns.update(c.id, { status: CampaignStatus.PAUSED });

    let calls = 0;
    await stepCampaign(
      { ...c, status: CampaignStatus.RUNNING },
      deps(() => {
        calls += 1;
        return dispatched('x');
      }, T0 + 60_000),
    );

    expect(calls).toBe(0); // re-read saw PAUSED and bailed
  });
});

// ---------------------------------------------------------------------------
describe('campaign runner - {name} personalisation', () => {
  const T0 = 1_000_000_000_000;

  it("fills each recipient's name into the body before sending, falling back for a blank name", async () => {
    const { campaign } = await campaignService.create({
      userId: 'u1',
      name: 'Personalised blast',
      body: 'Hi {name}, this is test',
      from: null,
      recipientRows: [
        { phone: '9876543210', name: 'Sharvesh' },
        { phone: '9123456780', name: null },
      ],
      countryCode: '+91',
      start: true,
    });

    const sent: string[] = [];
    const send: RunnerDeps['send'] = (p) => {
      sent.push(p.body);
      return Promise.resolve({ message: { id: 'm-' + p.recipient } as unknown as Message, dispatched: true });
    };
    const deps = (now: number): RunnerDeps => ({
      send,
      now: () => now,
      currentHour: () => 12,
      canSend: () => Promise.resolve(true),
    });

    // Two steps, the second well past the interval, to send both recipients.
    await stepCampaign(campaign, deps(T0));
    const mid = await repositories().campaigns.findById(campaign.id);
    if (!mid) throw new Error('campaign vanished');
    await stepCampaign(mid, deps(T0 + 60_000));

    expect(sent).toEqual(['Hi Sharvesh, this is test', 'Hi there, this is test']);
  });

  it('merges every column into the body - three variables, one send each', async () => {
    const { campaign, variables } = await campaignService.create({
      userId: 'u1',
      name: 'Rent reminder',
      body: 'Hi {name}, rent of {amount} is due on {due_date}.',
      from: null,
      recipientRows: [
        { phone: '9876543210', vars: { name: 'Asha', amount: 'Rs 12,000', 'Due Date': '5 Sep' } },
        { phone: '9123456780', vars: { name: 'Bala', amount: 'Rs 9,500', 'Due Date': '7 Sep' } },
      ],
      countryCode: '+91',
      start: true,
    });

    expect(variables).toEqual(['name', 'amount', 'due_date']);

    const sent: string[] = [];
    const deps = (now: number): RunnerDeps => ({
      send: (p) => {
        sent.push(p.body);
        return Promise.resolve({ message: { id: 'm-' + p.recipient } as unknown as Message, dispatched: true });
      },
      now: () => now,
      currentHour: () => 12,
      canSend: () => Promise.resolve(true),
    });

    await stepCampaign(campaign, deps(T0));
    const mid = await repositories().campaigns.findById(campaign.id);
    if (!mid) throw new Error('campaign vanished');
    await stepCampaign(mid, deps(T0 + 60_000));

    expect(sent).toEqual(['Hi Asha, rent of Rs 12,000 is due on 5 Sep.', 'Hi Bala, rent of Rs 9,500 is due on 7 Sep.']);
  });

  it('FAILS a row with an empty cell rather than texting the raw {placeholder}', async () => {
    const { campaign, incomplete } = await campaignService.create({
      userId: 'u1',
      name: 'Rent reminder',
      body: 'Rent of {amount} is due.',
      from: null,
      recipientRows: [
        { phone: '9876543210', vars: { amount: '' } }, // the hole
        { phone: '9123456780', vars: { amount: 'Rs 9,500' } },
      ],
      countryCode: '+91',
      start: true,
    });

    // The operator is told the count up front, at creation.
    expect(incomplete).toBe(1);

    const sent: string[] = [];
    const deps = (now: number): RunnerDeps => ({
      send: (p) => {
        sent.push(p.body);
        return Promise.resolve({ message: { id: 'm-' + p.recipient } as unknown as Message, dispatched: true });
      },
      now: () => now,
      currentHour: () => 12,
      canSend: () => Promise.resolve(true),
    });

    // First step lands on the incomplete row: nothing is sent, and because no SIM
    // was touched the pacing clock is not spent either.
    await stepCampaign(campaign, deps(T0));
    const mid = await repositories().campaigns.findById(campaign.id);
    if (!mid) throw new Error('campaign vanished');
    expect(sent).toEqual([]);
    expect(mid.recipients[0]?.status).toBe(RecipientStatus.FAILED);
    expect(mid.recipients[0]?.error).toMatch(/\{amount\}/);
    expect(mid.failedCount).toBe(1);
    expect(mid.lastSendAt).toBeNull();

    // The rest of the list carries on untouched.
    await stepCampaign(mid, deps(T0 + 1_000));
    expect(sent).toEqual(['Rent of Rs 9,500 is due.']);
  });

  it('refuses a body whose variable no column supplies - every message would go out broken', async () => {
    await expect(
      campaignService.create({
        userId: 'u1',
        name: 'Typo',
        body: 'Rent of {amont} is due.', // typo: the column is "amount"
        from: null,
        recipientRows: [{ phone: '9876543210', vars: { amount: 'Rs 900' } }],
        countryCode: '+91',
        start: false,
      }),
    ).rejects.toThrow(/\{amont\}/);
  });

  it('segments the longest message the campaign can produce, not the bare template', async () => {
    const long = 'x'.repeat(200);
    const { campaign } = await campaignService.create({
      userId: 'u1',
      name: 'Long merge',
      body: 'Note: {note}',
      from: null,
      recipientRows: [
        { phone: '9876543210', vars: { note: 'ok' } },
        { phone: '9123456780', vars: { note: long } },
      ],
      countryCode: '+91',
      start: false,
    });

    // "Note: " + 120 characters (the per-variable cap) is still one part; the point
    // is that it is measured against the merged message, not the 12-char template.
    expect(campaign.partCount).toBe(1);

    const { campaign: two } = await campaignService.create({
      userId: 'u1',
      name: 'Long merge 2',
      body: `${'y'.repeat(120)} {note}`,
      from: null,
      recipientRows: [{ phone: '9876543210', vars: { note: long } }],
      countryCode: '+91',
      start: false,
    });
    expect(two.partCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('the operator flow - upload a sheet, map its columns, send', () => {
  /**
   * The whole path an operator actually walks, over real HTTP: upload the .xlsx,
   * read back the columns, map them the way the panel maps them, and create the
   * campaign. Every layer in one test, because the interesting failures here are
   * at the seams - a column index that means one thing to the parser and another
   * to the caller would pass every unit test and text the wrong figure to the
   * whole list.
   */
  it('carries three spreadsheet columns through to a merged message', async () => {
    const app = createApp();

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ops@example.com', password: 'correct-horse-battery', name: 'Ops' })
      .expect(201);
    const auth = 'Bearer ' + (registered.body.data.tokens.accessToken as string);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rent');
    ws.addRow(['Name', 'Mobile', 'Rent Amount', 'Due Date']);
    ws.addRow(['Asha', '9876543210', 'Rs 12,000', '5 Sep']);
    ws.addRow(['Bala', 9123456780, 'Rs 9,500', '7 Sep']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const parsed = await request(app)
      .post('/api/campaigns/parse-recipients')
      .set('Authorization', auth)
      .attach('file', buffer, 'rent.xlsx')
      .expect(200);

    const table = parsed.body.data as {
      columns: Array<{ index: number; header: string; key: string; role: string; sample: string | null }>;
      rows: string[][];
      phoneColumn: number;
    };
    expect(table.columns.map((c) => c.key)).toEqual(['name', 'mobile', 'rent_amount', 'due_date']);
    expect(table.phoneColumn).toBe(1);
    expect(table.rows).toHaveLength(2);

    // Exactly what the panel does with that table: the phone column becomes the
    // number, every column marked "variable" becomes a template variable.
    const phone = table.columns[table.phoneColumn]!;
    const variables = table.columns.filter((c) => c.role === 'variable');
    const recipientRows = table.rows.map((row) => ({
      phone: row[phone.index],
      vars: Object.fromEntries(variables.map((c) => [c.key, row[c.index]])),
    }));

    const created = await request(app)
      .post('/api/campaigns')
      .set('Authorization', auth)
      .send({
        name: 'Rent reminder',
        body: 'Hi {name}, rent of {rent_amount} is due on {due_date}.',
        recipientRows,
        countryCode: '+91',
        start: false,
      })
      .expect(201);

    expect(created.body.meta.variables).toEqual(['name', 'rent_amount', 'due_date']);
    expect(created.body.meta.incomplete).toBe(0);
    expect(created.body.data.recipients).toEqual([
      expect.objectContaining({
        to: '+919876543210',
        name: 'Asha',
        vars: { name: 'Asha', rent_amount: 'Rs 12,000', due_date: '5 Sep' },
      }),
      expect.objectContaining({
        to: '+919123456780',
        name: 'Bala',
        vars: { name: 'Bala', rent_amount: 'Rs 9,500', due_date: '7 Sep' },
      }),
    ]);

    // And the message each of them would receive.
    const campaign = await repositories().campaigns.findById(created.body.data.id as string);
    if (!campaign) throw new Error('campaign vanished');
    expect(campaign.recipients.map((r) => renderBody(campaign.body, r.vars))).toEqual([
      'Hi Asha, rent of Rs 12,000 is due on 5 Sep.',
      'Hi Bala, rent of Rs 9,500 is due on 7 Sep.',
    ]);
  });

  it('refuses the campaign when a column the message needs was never mapped', async () => {
    const app = createApp();

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ops2@example.com', password: 'correct-horse-battery', name: 'Ops' })
      .expect(201);
    const auth = 'Bearer ' + (registered.body.data.tokens.accessToken as string);

    const failed = await request(app)
      .post('/api/campaigns')
      .set('Authorization', auth)
      .send({
        name: 'Rent reminder',
        body: 'Rent of {rent_amount} is due.',
        recipientRows: [{ phone: '9876543210', vars: { name: 'Asha' } }],
        countryCode: '+91',
        start: false,
      })
      .expect(400);

    expect(failed.body.error.message).toMatch(/\{rent_amount\}/);
  });
});
