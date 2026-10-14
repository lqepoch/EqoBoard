import { randomBytes } from 'node:crypto';

const MAX_LIMIT = 1000;
const MAX_DAYS = 11_000;
const MAX_PAGES_PER_QUERY = 20;
const MAX_CURSORS = 256;
const CURSOR_TTL_MS = 30 * 60 * 1000;
const HISTORY_REQUEST_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_DECIMAL_INPUT_BYTES = 128;
const MAX_DECIMAL_SCALE = 28;
const MAX_DECIMAL_COEFFICIENT = (1n << 127n) - 1n;
const NEW_YORK = 'America/New_York';

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const TIMEFRAMES = Object.freeze({
  '1Min': { sdkName: 'KLType_1Min', session: 'ALL', intraday: true },
  '5Min': { sdkName: 'KLType_5Min', session: 'ALL', intraday: true },
  '15Min': { sdkName: 'KLType_15Min', session: 'ALL', intraday: true },
  '1Hour': { sdkName: 'KLType_60Min', session: 'ALL', intraday: true },
  '1Day': { sdkName: 'KLType_Day', session: 'REGULAR', intraday: false },
  '1Week': { sdkName: 'KLType_Week', session: 'REGULAR', intraday: false },
  '1Month': { sdkName: 'KLType_Month', session: 'REGULAR', intraday: false },
});

const ET_OFFSETS_BY_DATE = new Map();
const invalid = message => { throw new Error(message); };

function asInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`invalid_${name}`);
  return value;
}

function parseRfc3339Utc(value, name) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)) {
    invalid(`invalid_${name}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    invalid(`invalid_${name}`);
  }
  return ms;
}

function partsAt(ms) {
  const fields = Object.fromEntries(ET_FORMATTER.formatToParts(new Date(ms))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return {
    year: fields.year, month: fields.month, day: fields.day,
    hour: fields.hour, minute: fields.minute, second: fields.second,
  };
}

function sameWallTime(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function validParts(parts) {
  if (!Number.isInteger(parts.year) || parts.year < 1970 || parts.year > 9999 ||
      !Number.isInteger(parts.month) || parts.month < 1 || parts.month > 12 ||
      !Number.isInteger(parts.day) || parts.day < 1 || parts.day > 31 ||
      !Number.isInteger(parts.hour) || parts.hour < 0 || parts.hour > 23 ||
      !Number.isInteger(parts.minute) || parts.minute < 0 || parts.minute > 59 ||
      !Number.isInteger(parts.second) || parts.second < 0 || parts.second > 59) return false;
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  return check.getUTCFullYear() === parts.year && check.getUTCMonth() + 1 === parts.month &&
    check.getUTCDate() === parts.day && check.getUTCHours() === parts.hour &&
    check.getUTCMinutes() === parts.minute && check.getUTCSeconds() === parts.second;
}

function parseEtTime(value) {
  if (typeof value !== 'string') invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
  };
  if (!validParts(parts)) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  return parts;
}

function wallClockAsUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetsAround(parts) {
  const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const cached = ET_OFFSETS_BY_DATE.get(dateKey);
  if (cached) return cached;
  const nominal = wallClockAsUtc({ ...parts, hour: 12, minute: 0, second: 0 });
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 60 * 60 * 1000;
    offsets.add(wallClockAsUtc(partsAt(sample)) - sample);
  }
  const values = [...offsets];
  ET_OFFSETS_BY_DATE.set(dateKey, values);
  if (ET_OFFSETS_BY_DATE.size > 512) ET_OFFSETS_BY_DATE.delete(ET_OFFSETS_BY_DATE.keys().next().value);
  return values;
}

function resolveEtTimestamp(value) {
  const parts = parseEtTime(value);
  const nominal = wallClockAsUtc(parts);
  const candidates = offsetsAround(parts)
    .map(offset => nominal - offset)
    .filter(candidate => sameWallTime(partsAt(candidate), parts));
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  return unique[0];
}

function etDate(ms) {
  const parts = partsAt(ms);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function normalizeRequest(request, nowMs) {
  if (!request || typeof request !== 'object' ||
      typeof request.symbol !== 'string' || !/^[A-Za-z][A-Za-z0-9.-]{0,11}$/.test(request.symbol)) {
    invalid('invalid_bars_query');
  }
  const symbol = request.symbol.toUpperCase();
  const timeframe = request.timeframe ?? '1Min';
  const frame = TIMEFRAMES[timeframe];
  if (!frame) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');

  const limit = asInteger(request.limit, 200, 1, MAX_LIMIT, 'limit');
  const hasStart = request.start !== undefined && request.start !== null;
  const hasEnd = request.end !== undefined && request.end !== null;
  if (hasStart !== hasEnd) invalid('invalid_bars_query');
  const legacy = !hasStart;
  const days = legacy ? asInteger(request.days, 14, 1, MAX_DAYS, 'days') : null;
  const endMs = hasEnd ? parseRfc3339Utc(request.end, 'end') : nowMs;
  const startMs = hasStart ? parseRfc3339Utc(request.start, 'start') : endMs - days * 86_400_000;
  if (startMs >= endMs) invalid('invalid_bars_query');

  const beginTime = etDate(startMs);
  const endTime = etDate(endMs - 1);
  const query = {
    symbol,
    timeframe,
    limit,
    startMs,
    endMs,
    beginTime,
    endTime,
    session: frame.session,
    intraday: frame.intraday,
    legacy,
    days,
  };
  query.key = JSON.stringify([
    query.symbol, query.timeframe, query.limit, query.startMs, query.endMs,
    query.beginTime, query.endTime, query.session,
  ]);
  return query;
}

function numberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('futu_invalid_response');
  if (value <= 0) invalid('futu_invalid_response');
  const source = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(source);
  if (!match) invalid('futu_invalid_response');
  const integer = match[1];
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');

  const digits = integer + fraction;
  const decimalPoint = integer.length + exponent;
  let text;
  let expandedLength;
  if (decimalPoint <= 0) {
    expandedLength = 2 + -decimalPoint + digits.length;
    if (expandedLength > MAX_DECIMAL_INPUT_BYTES) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
    text = `0.${'0'.repeat(-decimalPoint)}${digits}`;
  } else if (decimalPoint >= digits.length) {
    expandedLength = decimalPoint;
    if (expandedLength > MAX_DECIMAL_INPUT_BYTES) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
    text = `${digits}${'0'.repeat(decimalPoint - digits.length)}`;
  } else {
    expandedLength = digits.length + 1;
    if (expandedLength > MAX_DECIMAL_INPUT_BYTES) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
    text = `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
  }

  if (text.length > MAX_DECIMAL_INPUT_BYTES || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  }
  const [whole, decimal = ''] = text.split('.');
  let coefficientDigits = `${whole}${decimal}`.replace(/^0+/, '') || '0';
  let scale = decimal.length;
  while (scale > 0 && coefficientDigits.endsWith('0')) {
    coefficientDigits = coefficientDigits.slice(0, -1);
    scale -= 1;
  }
  if (scale > MAX_DECIMAL_SCALE || BigInt(coefficientDigits) > MAX_DECIMAL_COEFFICIENT) {
    invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  }
  return text;
}

function volumeText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    invalid('UNSUPPORTED_PROVIDER_CAPABILITY');
  }
  const text = typeof value === 'object' && typeof value.toString === 'function'
    ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) invalid('futu_invalid_response');
  try { BigInt(text); } catch { invalid('futu_invalid_response'); }
  return text;
}

function bytesValue(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  invalid('futu_invalid_response');
}

function providerError(error, usesAllSession) {
  if (error === 'timeout' || error?.message === 'timeout' || error?.message === 'futu_timeout' ||
      /timeout|timed out|超时/i.test(String(error?.retMsg ?? error?.message ?? ''))) {
    return 'futu_timeout';
  }
  const message = String(error?.retMsg ?? error?.message ?? error ?? '').toLowerCase();
  if (/rate|frequency|too many|限频|频率/.test(message)) return 'futu_rate_limited';
  if (/quota|permission|entitlement|authority|权限|额度|无权/.test(message)) return 'futu_history_permission_denied';
  if (usesAllSession && /session|version|unsupported|not support|不支持|版本/.test(message)) {
    return 'UNSUPPORTED_PROVIDER_CAPABILITY';
  }
  return 'futu_read_failed';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class FutuHistory {
  constructor(sdk, {
    klTypes,
    klFields,
    rehabTypeNone,
    sessionAll,
    now = Date.now,
    wait = sleep,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  }) {
    this.sdk = sdk;
    this.klTypes = klTypes;
    this.klFields = klFields;
    this.rehabTypeNone = rehabTypeNone;
    this.sessionAll = sessionAll;
    this.now = now;
    this.wait = wait;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextRequestAt = 0;
    this.cursors = new Map();
  }

  connectionChanged(connected) {
    if (!connected) this.cursors.clear();
  }

  #pruneCursors(now) {
    for (const [token, entry] of this.cursors) {
      if (now - entry.createdAt > CURSOR_TTL_MS) this.cursors.delete(token);
    }
    while (this.cursors.size >= MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value);
  }

  #resolveQuery(request, now) {
    if (request.cursor === undefined || request.cursor === null) {
      return { query: normalizeRequest(request, now), pageKey: null, pageNumber: 1, cursorToken: null };
    }
    if (typeof request.cursor !== 'string' || request.cursor.length === 0) invalid('invalid_cursor');
    const state = this.cursors.get(request.cursor);
    if (!state || now - state.createdAt > CURSOR_TTL_MS) {
      this.cursors.delete(request.cursor);
      invalid('invalid_cursor');
    }
    const supplied = normalizeRequest(request, now);
    if (supplied.key !== state.query.key) {
      // A days-only continuation reuses the frozen range returned on its first page.
      const sameLegacyInput = state.query.legacy && supplied.legacy &&
        supplied.symbol === state.query.symbol && supplied.timeframe === state.query.timeframe &&
        supplied.limit === state.query.limit && supplied.days === state.query.days;
      if (!sameLegacyInput) invalid('cursor_query_mismatch');
      return { query: state.query, pageKey: Buffer.from(state.pageKey),
        pageNumber: state.pageNumber, cursorToken: request.cursor };
    }
    return { query: state.query, pageKey: Buffer.from(state.pageKey),
      pageNumber: state.pageNumber, cursorToken: request.cursor };
  }

  async #waitForRateLimit() {
    const now = this.now();
    const scheduled = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = scheduled + HISTORY_REQUEST_INTERVAL_MS;
    if (scheduled > now) await this.wait(scheduled - now);
  }

  async #request(c2s) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.sdk.RequestHistoryKL({ c2s })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('futu_timeout')), this.requestTimeoutMs);
        }),
      ]);
    } catch (error) {
      throw new Error(providerError(error, c2s.session === this.sessionAll));
    } finally {
      clearTimeout(timer);
    }
  }

  async bars(request) {
    const receivedAtMs = this.now();
    const { query, pageKey, pageNumber, cursorToken } = this.#resolveQuery(request, receivedAtMs);
    const frame = TIMEFRAMES[query.timeframe];
    const klType = this.klTypes[frame.sdkName];
    if (!Number.isSafeInteger(klType) || !Number.isSafeInteger(this.rehabTypeNone) ||
        !Number.isSafeInteger(this.sessionAll)) invalid('UNSUPPORTED_PROVIDER_CAPABILITY');

    await this.#waitForRateLimit();
    const fields = this.klFields;
    const c2s = {
      rehabType: this.rehabTypeNone,
      klType,
      security: { market: 11, code: query.symbol },
      beginTime: query.beginTime,
      endTime: query.endTime,
      maxAckKLNum: query.limit,
      needKLFieldsFlag: fields.KLFields_High | fields.KLFields_Open | fields.KLFields_Low |
        fields.KLFields_Close | fields.KLFields_Volume,
    };
    if (query.session === 'ALL') c2s.session = this.sessionAll;
    if (pageKey) c2s.nextReqKey = pageKey;

    const response = await this.#request(c2s);
    if (!response || response.retType !== 0 || !response.s2c ||
        !Array.isArray(response.s2c.klList) || response.s2c.klList.length > query.limit) {
      invalid('futu_invalid_response');
    }

    const nextPageKey = bytesValue(response.s2c.nextReqKey);
    if (pageKey && nextPageKey?.equals(pageKey)) invalid('futu_invalid_response');
    if (cursorToken) this.cursors.delete(cursorToken);
    const now = this.now();
    const receivedAt = new Date(now).toISOString();
    const bars = [];
    for (const row of response.s2c.klList) {
      if (row?.isBlank === true) continue;
      const eventTimeEt = row?.time;
      const eventMs = resolveEtTimestamp(eventTimeEt);
      const inside = query.intraday
        ? eventMs >= query.startMs && eventMs < query.endMs
        : eventTimeEt.slice(0, 10) >= query.beginTime && eventTimeEt.slice(0, 10) <= query.endTime;
      if (!inside) continue;
      bars.push({
        time: new Date(eventMs).toISOString(),
        event_time_et: eventTimeEt,
        received_at: receivedAt,
        open: numberText(row.openPrice),
        high: numberText(row.highPrice),
        low: numberText(row.lowPrice),
        close: numberText(row.closePrice),
        volume: volumeText(row.volume),
      });
    }

    let cursor = null;
    const hasMore = nextPageKey !== null && nextPageKey.length > 0;
    const truncated = hasMore && pageNumber >= MAX_PAGES_PER_QUERY;
    if (hasMore && !truncated) {
      this.#pruneCursors(now);
      cursor = randomBytes(24).toString('base64url');
      this.cursors.set(cursor, { query, pageKey: nextPageKey, createdAt: now, pageNumber: pageNumber + 1 });
    }
    return {
      symbol: query.symbol,
      timeframe: query.timeframe,
      feed: 'futu',
      source_mode: 'futu',
      source_label: 'Futu OpenD',
      source_entitlement: 'unknown',
      adjustment: 'none',
      session: query.session,
      numeric_encoding: 'binary_float_projection',
      start: new Date(query.startMs).toISOString(),
      end: new Date(query.endMs).toISOString(),
      bars,
      pages_fetched: pageNumber,
      has_more: hasMore,
      cursor,
      truncated,
    };
  }
}
