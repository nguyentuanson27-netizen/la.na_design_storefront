import qrcode from "qrcode-generator";

/**
 * VietQR (NAPAS 247 transfer to an account) as an EMVCo QR payload, and the QR itself as an SVG
 * path.
 *
 * Built here, on the server, from the order's own facts: nothing about the account, amount or
 * content is sent to a third-party QR service, and the page needs no extra image origin.
 */

const GUID_NAPAS = "A000000727";
const SERVICE_TO_ACCOUNT = "QRIBFTTA";
const CURRENCY_VND = "704";
/** Banks keep the purpose field short; a longer reference would be cut off, so no QR is made for it. */
const MAX_QR_CONTENT_LENGTH = 25;
const QR_CONTENT = /^[A-Za-z0-9 .\-_]+$/;

function field(id: string, value: string): string {
  if (value.length > 99) throw new RangeError("QR field is too long");
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index += 1) {
    crc ^= text.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export type VietQrInput = Readonly<{
  /** The receiving bank's six-digit NAPAS BIN, for example `970422` for MB Bank. */
  bankBin: string;
  accountNumber: string;
  amountVnd: number;
  content: string;
}>;

/** The payload, or `null` when any part of it cannot be stated safely. */
export function buildVietQrPayload(input: VietQrInput): string | null {
  const { bankBin, accountNumber, amountVnd, content } = input;
  if (!/^[0-9]{6}$/.test(bankBin)) return null;
  if (!/^[0-9]{6,19}$/.test(accountNumber)) return null;
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) return null;
  if (content.length === 0 || content.length > MAX_QR_CONTENT_LENGTH || !QR_CONTENT.test(content)) return null;

  const beneficiary = field("00", bankBin) + field("01", accountNumber);
  const body =
    field("00", "01") +
    field("01", "12") +
    field("38", field("00", GUID_NAPAS) + field("01", beneficiary) + field("02", SERVICE_TO_ACCOUNT)) +
    field("53", CURRENCY_VND) +
    field("54", String(amountVnd)) +
    field("58", "VN") +
    field("62", field("08", content)) +
    "6304";
  return body + crc16(body);
}

export type QrImage = Readonly<{
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** One SVG path of every dark module, in module units. */
  path: string;
}>;

export function buildQrImage(payload: string): QrImage {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  const size = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return Object.freeze({ size, path });
}
