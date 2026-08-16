// Vercel Serverless Function
// 직급/연봉밴드 엑셀 업로드(파싱→저장), 조회, 재다운로드를 처리한다.
//
// 파싱 방식: 고정 셀 좌표에 의존하지 않고, "구분" 열(직급명)과 "N년차" 패턴을 스캔해서
// 직급 구간을 동적으로 인식한다. 파일 구조가 이미 한 번 바뀐 전례(시트 통합, 직무군 5→4개 재편)가
// 있어, 향후 행 개수가 조금 바뀌어도 견딜 수 있도록 설계함. 단, 열 배치(구분/년차/호봉/연봉/
// 직무군별 %,MIN·MAX 반복 배치)는 유지되어야 한다.
//
// 원본 값에 수식 계산 잔차(예: 60,004)가 섞여있어, 저장 시 100(천원) 단위로 반올림해서
// 깔끔한 값으로 정리한다.

import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const JOB_CATEGORY_START_COL = 6 // 첫 직무군의 '%' 열 (0-indexed, A=0 기준 G열)
const NUM_CATEGORIES = 4

function parseSalaryBandWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetName = workbook.SheetNames[0]
  const ws = workbook.Sheets[sheetName]
  const range = XLSX.utils.decode_range(ws['!ref'])

  function cell(r, c) {
    const addr = XLSX.utils.encode_cell({ r, c })
    const cellObj = ws[addr]
    return cellObj ? cellObj.v : null
  }

  // "구분" 문자열이 있는 헤더 행을 찾는다 (열 배치 기준점)
  let headerRow = -1
  for (let r = range.s.r; r <= range.e.r; r++) {
    if (String(cell(r, 1) || '').includes('구분')) {
      headerRow = r
      break
    }
  }
  if (headerRow === -1) throw new Error('헤더 행("구분")을 찾지 못했습니다. 엑셀 구조를 확인해주세요.')

  // 직무군 이름은 "구분" 헤더 행보다 2행 위(본부/센터명), 1행 위(소속 세부 직무 나열)에 각각 있음.
  // 본부명은 category로, 세부직무 나열은 job_functions로 별도 저장 — AI 자동매칭 시 세부직무까지 참고해야
  // 정확도가 나오므로 둘 다 보존한다 (이전 버전은 본부명만 남기고 세부직무를 버려서 매칭 정확도가 낮았음).
  const categories = []
  const jobFunctionsByCategory = []
  for (let k = 0; k < NUM_CATEGORIES; k++) {
    const col = JOB_CATEGORY_START_COL + k * 2
    const divisionName = cell(headerRow - 2, col)
    const jobDetail = cell(headerRow - 1, col)
    categories.push(String(divisionName || jobDetail || `직무군${k + 1}`).trim())
    jobFunctionsByCategory.push(jobDetail ? String(jobDetail).trim() : null)
  }

  const rows = []
  let currentGrade = null
  let r = headerRow + 3 // "구분" 행 다음 MIN/MAX 라벨 2행을 건너뛰고 데이터 시작
  while (r <= range.e.r) {
    const gradeCell = cell(r, 1)
    if (gradeCell) currentGrade = String(gradeCell).replace(/\s+/g, ' ').trim()
    const yearLabel = cell(r, 3)
    if (yearLabel && String(yearLabel).includes('년차')) {
      const yearNum = parseInt(String(yearLabel).replace('년차', ''), 10)
      const stepLabel = cell(r, 4)
      const baseSalary = cell(r, 5)
      const minRow = r
      const maxRow = r + 1
      for (let k = 0; k < NUM_CATEGORIES; k++) {
        const col = JOB_CATEGORY_START_COL + k * 2 + 1
        const minVal = cell(minRow, col)
        const maxVal = cell(maxRow, col)
        rows.push({
          grade: currentGrade,
          year_num: yearNum,
          step: stepLabel === '초임' ? 1 : Number(stepLabel) || 1,
          category: categories[k],
          job_functions: jobFunctionsByCategory[k],
          min_salary: minVal != null && !isNaN(minVal) ? Math.round(Number(minVal) / 100) * 100 : null,
          max_salary: maxVal != null && !isNaN(maxVal) ? Math.round(Number(maxVal) / 100) * 100 : null,
          base_salary: baseSalary != null && !isNaN(baseSalary) ? Number(baseSalary) : null,
        })
      }
      r += 2
    } else {
      r += 1
    }
  }

  if (rows.length === 0) throw new Error('파싱된 데이터가 없습니다. 엑셀 구조를 확인해주세요.')
  return { categories, rows }
}

export default async function handler(req, res) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되어 있지 않습니다.' })
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  if (req.method === 'GET') {
    // ?format=xlsx 이면 현재 저장된 데이터를 엑셀로 재구성해서 다운로드
    try {
      const { data, error } = await supabase.from('salary_bands').select('*').order('year_num').order('category')
      if (error) return res.status(500).json({ error: error.message })

      if (req.query.format === 'xlsx') {
        const aoa = [['직급', '년차', '호봉', '직무군', 'MIN(천원)', 'MAX(천원)', '기준연봉(천원)']]
        for (const row of data || []) {
          aoa.push([row.grade, row.year_num, row.step, row.category, row.min_salary, row.max_salary, row.base_salary])
        }
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet(aoa)
        XLSX.utils.book_append_sheet(wb, ws, '연봉밴드')
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="salary_bands_export.xlsx"')
        return res.status(200).send(buf)
      }

      const { data: uploadMeta } = await supabase
        .from('salary_band_uploads')
        .select('*')
        .order('uploaded_at', { ascending: false })
        .limit(1)

      return res.status(200).json({ bands: data || [], lastUpload: uploadMeta?.[0] || null })
    } catch (err) {
      return res.status(500).json({ error: '조회 중 오류: ' + err.message })
    }
  }

  if (req.method === 'POST') {
    const { fileBase64, filename } = req.body || {}
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64가 필요합니다.' })
    try {
      const buffer = Buffer.from(fileBase64, 'base64')
      const { rows } = parseSalaryBandWorkbook(buffer)

      // 기존 데이터 전부 삭제 후 새로 삽입 (스냅샷 교체 방식)
      const { error: delErr } = await supabase.from('salary_bands').delete().neq('id', '00000000-0000-0000-0000-000000000000')
      if (delErr) return res.status(500).json({ error: '기존 데이터 삭제 실패: ' + delErr.message })

      const { error: insErr } = await supabase.from('salary_bands').insert(rows)
      if (insErr) return res.status(500).json({ error: '저장 실패: ' + insErr.message })

      await supabase.from('salary_band_uploads').insert({ filename: filename || null, row_count: rows.length })

      return res.status(200).json({ success: true, inserted: rows.length })
    } catch (err) {
      return res.status(500).json({ error: '엑셀 파싱/저장 중 오류: ' + err.message })
    }
  }

  return res.status(405).json({ error: 'GET 또는 POST만 허용됩니다.' })
}
