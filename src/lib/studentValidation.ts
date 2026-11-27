/**
 * Shared validation and normalization utilities for unauthenticated Student Exam Entry.
 * Used identically by frontend forms and backend API validation.
 */

export function normalizeStudentName(raw: string): {
  display: string
  normalized: string
} {
  const collapsed = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return {
    display: collapsed,
    normalized: collapsed.toLocaleLowerCase('vi-VN'),
  }
}

export function validateStudentFullName(
  raw: string
):
  | { ok: true; display: string; normalized: string }
  | { ok: false; error: string } {
  const { display, normalized } = normalizeStudentName(raw)

  if (!display) {
    return { ok: false, error: 'Vui lòng nhập họ và tên học sinh.' }
  }
  if (display.length < 2 || display.length > 100) {
    return {
      ok: false,
      error: 'Họ và tên phải có độ dài từ 2 đến 100 ký tự.',
    }
  }
  if (/[<>;"`\\{}[\]]/.test(display)) {
    return {
      ok: false,
      error: 'Họ và tên chứa ký tự không hợp lệ.',
    }
  }

  // Must contain at least two letters and not be purely digits/punctuation
  const letterMatches = display.match(/\p{L}/gu)
  if (!letterMatches || letterMatches.length < 2) {
    return {
      ok: false,
      error: 'Họ và tên phải chứa chữ cái hợp lệ (ví dụ: Nguyễn Minh Anh).',
    }
  }

  return { ok: true, display, normalized }
}

/**
 * Normalizes class names to a consistent canonical format:
 * e.g. " 12 a 1 " -> "12A1", "12-a2" -> "12A2", "12/A10" -> "12A10",
 * "12 chuyên tin" -> "12 CHUYÊN TIN".
 */
export function normalizeClassName(raw: string): string {
  const cleaned = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''

  // Standard Vietnamese high-school format: Grade + Letters + Optional Digits
  const compactMatch = cleaned.match(
    /^(1[0-2]|[6-9])\s*[-/._ ]?\s*([a-zA-ZÀ-ỹ]{1,4})\s*[-/._ ]?\s*(\d{1,2})$/
  )
  if (compactMatch) {
    const [, grade, letter, num] = compactMatch
    return `${grade}${letter.toUpperCase()}${Number(num)}`
  }

  // Grade + single/multiple letters without trailing number (e.g., 12A, 12CT)
  const letterOnlyMatch = cleaned.match(/^(1[0-2]|[6-9])\s*[-/._ ]?\s*([a-zA-ZÀ-ỹ]{1,6})$/)
  if (letterOnlyMatch) {
    const [, grade, letter] = letterOnlyMatch
    return `${grade}${letter.toUpperCase()}`
  }

  // Named classes such as "12 Chuyên Tin", "11 Tin 1"
  return cleaned
    .replace(/\s*[-/]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('vi-VN')
}

export function validateClassName(
  raw: string
):
  | { ok: true; rawClean: string; normalized: string }
  | { ok: false; error: string } {
  const rawClean = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!rawClean) {
    return { ok: false, error: 'Vui lòng nhập tên lớp (ví dụ: 12A1).' }
  }
  if (rawClean.length < 2 || rawClean.length > 30) {
    return {
      ok: false,
      error: 'Tên lớp phải có từ 2 đến 30 ký tự (ví dụ: 12A1, 11B2, 12 Chuyên Tin).',
    }
  }
  if (/[<>;"`\\{}[\]]/.test(rawClean)) {
    return {
      ok: false,
      error: 'Tên lớp chứa ký tự không hợp lệ.',
    }
  }

  const normalized = normalizeClassName(rawClean)
  const hasGradeAndLetter = /^(1[0-2]|[6-9])\s*[A-ZÀ-Ỹ]/i.test(normalized)
  const hasLettersAndDigits =
    /\p{L}/u.test(normalized) && /\d/.test(normalized) && normalized.length >= 3

  if (!hasGradeAndLetter && !hasLettersAndDigits) {
    return {
      ok: false,
      error:
        'Tên lớp chưa đúng định dạng (cần có khối lớp và ký hiệu lớp, ví dụ: 12A1, 11B3, 12 Chuyên Tin).',
    }
  }

  return { ok: true, rawClean, normalized }
}
