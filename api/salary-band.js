// Vercel Serverless Function
// 직급/연봉밴드 엑셀 업로드(파싱→저장), 조회, 재다운로드, 개별 셀 수정을 처리한다.
//
// [2026-08-16 수정] 3가지 반영:
// 1) 업로드 시 기존 데이터를 삭제하지 않고 active=false로 비활성화만 함 (소프트삭제).
//    실수로 잘못된 파일을 올려도 Supabase에서 직접 active를 되돌려 복구 가능.
// 2) PUT(개별 수정) 시 MIN > MAX가 되는 저장을 차단.
// 3) PUT 수정 시 salary_band_edit_log에 이전값/이후값 기록.

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

  let headerRow = -1
  for (let r = range.s.r; r <= range.e.r; r++) {
    if (String(cell(r, 1) || '').includes('구분')) {
      headerRow = r
      break
    }
  }
  if (headerRow === -1) throw new Error('헤더 행("구분")을 찾지 못했습니다. 엑셀 구조를 확인해주세요.')

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
  let r = headerRow + 3
  while (r <= range.e.r) {
    const gradeCell = cell(r, 1)
    if (gradeCell) currentGrade = String(gradeCell).replace(/\s+/g, ' ').trim()
    const yearLabel = cell(r, 3)
    if (yearLabel && String(yearLabel).includes('년차')) {
      const yearNum = parseInt(String(yearLabel).replace('년차', ''), 10)
      const stepLabel = cell(r, 4)
      const baseSalary = cell(r, 5)
      const nextRowYearLabel = cell(r + 1, 3)
      const hasSecondRow = !nextRowYearLabel
      const minRow = r
      const maxRow = hasSecondRow ? r + 1 : null
      for (let k = 0; k < NUM_CATEGORIES; k++) {
        const col = JOB_CATEGORY_START_COL + k * 2 + 1
        const minVal = cell(minRow, col)
        const maxVal = maxRow != null ? cell(maxRow, col) : null
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
      r += hasSecondRow ? 2 : 1
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
    try {
      const { data, error } = await supabase
        .from('salary_bands')
        .select('*')
        .eq('active', true)
        .order('year_num')
        .order('category')
      if (error) return res.status(500).json({ error: error.message })

      if (req.query.format === 'xlsx') {
        const aoa = [['직급', '년차', '호봉', '직무군', '세부직무', 'MIN(천원)', 'MAX(천원)', '기준연봉(천원)']]
        for (const row of data || []) {
          aoa.push([row.grade, row.year_num, row.step, row.category, row.job_functions, row.min_salary, row.max_salary, row.base_salary])
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

      // 기존 활성 데이터는 삭제하지 않고 비활성화만 함 (소프트삭제) — 실수 업로드 시 복구 가능
      const { error: deactivateErr } = await supabase.from('salary_bands').update({ active: false }).eq('active', true)
      if (deactivateErr) return res.status(500).json({ error: '기존 데이터 비활성화 실패: ' + deactivateErr.message })

      const { data: uploadRow, error: uploadInsertErr } = await supabase
        .from('salary_band_uploads')
        .insert({ filename: filename || null, row_count: rows.length })
        .select()
        .single()
      if (uploadInsertErr) return res.status(500).json({ error: '업로드 이력 저장 실패: ' + uploadInsertErr.message })

      const rowsWithBatch = rows.map((r) => ({ ...r, active: true, upload_batch_id: uploadRow.id }))
      const { error: insErr } = await supabase.from('salary_bands').insert(rowsWithBatch)
      if (insErr) return res.status(500).json({ error: '저장 실패: ' + insErr.message })

      return res.status(200).json({ success: true, inserted: rows.length })
    } catch (err) {
      return res.status(500).json({ error: '엑셀 파싱/저장 중 오류: ' + err.message })
    }
  }

  if (req.method === 'PUT') {
    const { id, min_salary, max_salary } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id가 필요합니다.' })

    try {
      const { data: current, error: curErr } = await supabase
        .from('salary_bands')
        .select('min_salary, max_salary')
        .eq('id', id)
        .single()
      if (curErr) return res.status(500).json({ error: '기존 값 조회 실패: ' + curErr.message })

      const updates = {}
      const logEntries = []

      if (min_salary !== undefined) {
        const num = min_salary === null ? null : Number(min_salary)
        if (min_salary !== null && isNaN(num)) return res.status(400).json({ error: 'min_salary는 숫자여야 합니다.' })
        updates.min_salary = num
        logEntries.push({ band_id: id, field: 'min_salary', old_value: current.min_salary, new_value: num })
      }
      if (max_salary !== undefined) {
        const num = max_salary === null ? null : Number(max_salary)
        if (max_salary !== null && isNaN(num)) return res.status(400).json({ error: 'max_salary는 숫자여야 합니다.' })
        updates.max_salary = num
        logEntries.push({ band_id: id, field: 'max_salary', old_value: current.max_salary, new_value: num })
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: '수정할 값(min_salary 또는 max_salary)이 없습니다.' })
      }

      // MIN > MAX가 되는 저장 차단 (수정 후 최종값 기준으로 검증)
      const finalMin = updates.min_salary !== undefined ? updates.min_salary : current.min_salary
      const finalMax = updates.max_salary !== undefined ? updates.max_salary : current.max_salary
      if (finalMin != null && finalMax != null && Number(finalMin) > Number(finalMax)) {
        return res.status(400).json({ error: `MIN(${finalMin})이 MAX(${finalMax})보다 클 수 없습니다.` })
      }

      const { error } = await supabase.from('salary_bands').update(updates).eq('id', id)
      if (error) return res.status(500).json({ error: '수정 실패: ' + error.message })

      await supabase.from('salary_band_edit_log').insert(logEntries)

      return res.status(200).json({ success: true })
    } catch (err) {
      return res.status(500).json({ error: '수정 중 오류: ' + err.message })
    }
  }

  return res.status(405).json({ error: 'GET, POST, PUT만 허용됩니다.' })
}
