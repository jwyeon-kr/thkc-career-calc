import React, { useState, useEffect, useRef } from 'react'
import { loadWeightConfig, calcAll } from './lib/calculator'
import { mapRevenueToBracket, formatWonToEok } from '../shared/revenueBracket'
import { suggestListedBonusEligible } from '../shared/listedBonusJobs'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

const EMPLOYMENT_TYPES = ['정규직', '계약직', '파견', '인턴']
const MATCH_LEVELS = ['동일', '유사', '기타']
const REVENUE_BRACKETS = ['중소', '중견', '대기업']

function newEntry() {
  return {
    id: crypto.randomUUID(),
    company_name: '',
    start_date: '',
    end_date: '',
    employment_type: '정규직',
    job_match: '',
    industry_match: '',
    revenue_bracket: '',
    revenue_source: 'manual',
    revenue_raw_value: '',
    is_conglomerate_affiliate: false,
    care_domain_confirmed: false,
    leadership_start_date: '',
    leadership_end_date: '',
    listed_bonus_eligible_job: false,
    listed_bonus_confirmed: false,
    job_title: '',
    revenue_lookup_status: 'idle',
    revenue_lookup_message: '',
    revenue_lookup_candidates: [],
    is_listed_hint: null,
    market_hint: null,
    established_hint: null,
  }
}

function HistoryEntryDetail({ entry }) {
  const c = entry.calc || {}
  return (
    <div className="history-entry-detail">
      <div className="history-entry-detail-header">
        <b>{entry.company_name}</b>
        <span>{entry.start_date} ~ {entry.end_date}</span>
        {entry.gap_flag && <span className="flag">경력단절 90일+</span>}
      </div>
      <div className="history-entry-detail-grid">
        <div><span className="label">고용형태</span>{entry.employment_type}</div>
        <div><span className="label">직무매칭</span>{entry.job_match || '미확인'}</div>
        <div><span className="label">업종매칭</span>{entry.industry_match || '미확인'}</div>
        <div><span className="label">기업규모</span>{entry.is_conglomerate_affiliate ? '대기업(계열사 확인)' : (entry.revenue_bracket || '미입력')}</div>
        <div><span className="label">돌봄도메인 특례</span>{entry.care_domain_confirmed ? '적용' : '미적용'}</div>
        <div><span className="label">상장가산</span>{entry.listed_bonus_confirmed ? '적용' : '미적용'}</div>
        <div><span className="label">팀장기간</span>{entry.leadership_start_date && entry.leadership_end_date ? `${entry.leadership_start_date} ~ ${entry.leadership_end_date}` : '-'}</div>
      </div>
      {c.entryYears !== undefined && (
        <div className="history-entry-detail-calc">
          <span>직무×업종 {c.jiPct ?? 0}% / 직무×기업규모 {c.jrPct ?? 0}%</span>
          <span>기본 {(c.afterEmployment ?? 0).toFixed(2)}년</span>
          {c.leadershipBonus > 0 && <span>리더십가산 +{c.leadershipBonus.toFixed(2)}년</span>}
          {c.listedBonus > 0 && <span>상장가산 +{c.listedBonus.toFixed(2)}년</span>}
          {c.careDomainBonus > 0 && <span>돌봄특례 +{c.careDomainBonus.toFixed(2)}년</span>}
          <b>계 {(c.entryYears ?? 0).toFixed(2)}년</b>
        </div>
      )}
    </div>
  )
}

// 인정경력년차 + 직무군으로 저장된 연봉밴드에서 해당 구간을 찾는다.
// 테이블에 있는 최대 년차보다 크면 "임원급, 데이터 없음"으로 처리(회사 방침: 22~25년차는 임원급이라 채용 대상이 거의 없어 데이터 미비 허용)
function findSalaryBand(bands, roundedYears, category) {
  if (!bands || bands.length === 0 || !category) return null
  const maxYear = Math.max(...bands.map((b) => b.year_num))
  const clampedYear = Math.min(roundedYears, maxYear)
  const row = bands.find((b) => b.year_num === clampedYear && b.category === category)
  if (!row) return { noData: true, executive: roundedYears > maxYear }
  if (row.min_salary == null || row.max_salary == null) {
    return { noData: true, executive: true, grade: row.grade }
  }
  return {
    noData: false,
    grade: row.grade,
    step: row.step,
    minSalary: row.min_salary,
    maxSalary: row.max_salary,
    exceededTable: roundedYears > maxYear,
  }
}

export default function App() {
  const [mainTab, setMainTab] = useState('calc') // calc | history | salary
  const [applicantName, setApplicantName] = useState('')
  const [targetJob, setTargetJob] = useState('')
  const [firstEntry] = useState(() => newEntry())
  const [entries, setEntries] = useState([firstEntry])
  const [expandedIds, setExpandedIds] = useState(() => new Set([firstEntry.id]))
  const [config, setConfig] = useState(null)
  const [result, setResult] = useState(null)
  const [tab, setTab] = useState('upload')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState([])
  const [saveMsg, setSaveMsg] = useState('')
  const [showCriteria, setShowCriteria] = useState(false)
  const [configWarning, setConfigWarning] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState(null)
  const [settingsMsg, setSettingsMsg] = useState('')
  const [settingsSavingKey, setSettingsSavingKey] = useState('')
  const [settingsEdits, setSettingsEdits] = useState({})
  const [selectedHistoryIds, setSelectedHistoryIds] = useState(new Set())
  const [historyDeleting, setHistoryDeleting] = useState(false)
  const [expandedHistoryIds, setExpandedHistoryIds] = useState(new Set())

  // 연봉밴드 관련 상태
  const [salaryBands, setSalaryBands] = useState([])
  const [salaryLastUpload, setSalaryLastUpload] = useState(null)
  const [salaryUploading, setSalaryUploading] = useState(false)
  const [salaryMsg, setSalaryMsg] = useState('')
  const [salaryEdits, setSalaryEdits] = useState({})
  const [salaryRowSavingId, setSalaryRowSavingId] = useState('')
  const [matchedCategory, setMatchedCategory] = useState(null)
  const [categoryMatching, setCategoryMatching] = useState(false)
  const [salaryBandResult, setSalaryBandResult] = useState(null)

  const resultRef = useRef(null)
  const fileInputRef = useRef(null)
  const salaryFileInputRef = useRef(null)

  useEffect(() => {
    loadWeightConfig().then((c) => {
      setConfig(c)
      if (c.errors?.length > 0) {
        setConfigWarning('가중치 데이터를 불러오지 못했습니다: ' + c.errors.join(' / ') + ' (Supabase 연결 문제일 수 있습니다. 네트워크 또는 방화벽 설정을 확인해주세요.)')
      } else if (c.isEmpty) {
        setConfigWarning('가중치 데이터가 비어있습니다. Supabase 테이블에 초기 데이터가 정상적으로 들어있는지 확인해주세요.')
      }
    })
    loadHistory()
    loadSalaryBands()
  }, [])

  async function loadHistory() {
    try {
      const res = await fetch('/api/applicants')
      const data = await safeJson(res)
      setHistory(data.history || [])
    } catch {
      setHistory([])
    }
  }

  async function loadSalaryBands() {
    try {
      const res = await fetch('/api/salary-band')
      const data = await safeJson(res)
      setSalaryBands(data.bands || [])
      setSalaryLastUpload(data.lastUpload || null)
    } catch {
      setSalaryBands([])
    }
  }

  async function handleSalaryUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    setSalaryUploading(true)
    setSalaryMsg('')
    try {
      const arrayBuffer = await file.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
      const res = await fetch('/api/salary-band', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64: base64, filename: file.name }),
      })
      const data = await safeJson(res)
      if (data.error) throw new Error(data.error)
      setSalaryMsg(`업로드 완료: ${data.inserted}건 저장되었습니다.`)
      loadSalaryBands()
    } catch (err) {
      setSalaryMsg('업로드 실패: ' + err.message)
    } finally {
      setSalaryUploading(false)
      if (salaryFileInputRef.current) salaryFileInputRef.current.value = ''
    }
  }

  function downloadSalaryXlsx() {
    window.open('/api/salary-band?format=xlsx', '_blank')
  }

  async function saveSalaryBandRow(id, field, value) {
    const num = Number(value)
    if (isNaN(num)) {
      setSalaryMsg('숫자만 입력 가능합니다.')
      return
    }
    setSalaryRowSavingId(id + field)
    setSalaryMsg('')
    try {
      const res = await fetch('/api/salary-band', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, [field]: num }),
      })
      const data = await safeJson(res)
      if (data.error) throw new Error(data.error)
      setSalaryMsg('저장되었습니다.')
      loadSalaryBands()
    } catch (err) {
      setSalaryMsg('저장 실패: ' + err.message)
    } finally {
      setSalaryRowSavingId('')
    }
  }

  function updateEntry(id, field, value) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)))
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings')
      const data = await safeJson(res)
      if (data.error) {
        setSettingsMsg('불러오기 실패: ' + data.error)
        return
      }
      setSettings(data)
    } catch (err) {
      setSettingsMsg('불러오기 실패: ' + err.message)
    }
  }

  async function saveSettingRow(table, match, value, rowKey) {
    const num = Number(value)
    if (isNaN(num)) {
      setSettingsMsg('숫자만 입력 가능합니다.')
      return
    }
    setSettingsSavingKey(rowKey)
    setSettingsMsg('')
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table, match, weight_percent: num }),
      })
      const data = await safeJson(res)
      if (data.error) throw new Error(data.error)
      setSettingsMsg('저장되었습니다.')
      loadSettings()
      loadWeightConfig().then(setConfig)
    } catch (err) {
      setSettingsMsg('저장 실패: ' + err.message)
    } finally {
      setSettingsSavingKey('')
    }
  }

  function toggleSettings() {
    const next = !showSettings
    setShowSettings(next)
    if (next && !settings) loadSettings()
  }

  function toggleHistorySelect(id) {
    setSelectedHistoryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleHistoryExpand(id) {
    setExpandedHistoryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function deleteSelectedHistory() {
    if (selectedHistoryIds.size === 0) return
    if (!confirm(`선택한 ${selectedHistoryIds.size}건을 삭제하시겠습니까? 되돌릴 수 없습니다.`)) return
    setHistoryDeleting(true)
    try {
      const res = await fetch('/api/applicants', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calculationResultIds: [...selectedHistoryIds] }),
      })
      const data = await safeJson(res)
      if (data.error) throw new Error(data.error)
      setSelectedHistoryIds(new Set())
      loadHistory()
    } catch (err) {
      alert('삭제 실패: ' + err.message)
    } finally {
      setHistoryDeleting(false)
    }
  }

  async function suggestJobMatch(entryId) {
    const entry = entries.find((e) => e.id === entryId)
    if (!targetJob.trim()) {
      alert('먼저 상단 "지원 직무"를 입력해주세요.')
      return
    }
    if (!entry.job_title?.trim()) {
      alert('이 경력에는 이력서에서 추출된 직무명이 없어 AI 제안을 쓸 수 없습니다 (이력서 업로드 없이 직접 추가한 경력으로 보입니다). 직무매칭을 직접 선택해주세요.')
      return
    }
    updateEntry(entryId, 'job_match_suggesting', true)
    try {
      const res = await fetch('/api/match-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetJob, jobTitle: entry.job_title }),
      })
      const data = await safeJson(res)
      if (data.error) throw new Error(data.error)
      updateEntry(entryId, 'job_match', data.job_match_suggestion)
    } catch (err) {
      alert('직무매칭 제안 실패: ' + err.message)
    } finally {
      updateEntry(entryId, 'job_match_suggesting', false)
    }
  }

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addEntry() {
    const e = newEntry()
    setEntries((prev) => [...prev, e])
    setExpandedIds((prev) => new Set(prev).add(e.id))
  }

  function removeEntry(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id))
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  async function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    try {
      const urlRes = await fetch('/api/get-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name }),
      })
      const urlData = await safeJson(urlRes)
      if (urlData.error) {
        alert('업로드 준비 실패: ' + urlData.error + '\n정형 입력으로 직접 입력해주세요.')
        setTab('manual')
        return
      }

      const putRes = await fetch(urlData.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!putRes.ok) {
        alert('파일 업로드 실패 (파일이 너무 크거나 네트워크 문제일 수 있습니다). 정형 입력으로 직접 입력해주세요.')
        setTab('manual')
        return
      }

      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: urlData.path, mediaType: file.type, targetJob }),
      })
      const data = await safeJson(res)
      if (data.error) {
        alert('추출 실패: ' + data.error + '\n정형 입력으로 직접 입력해주세요.')
        setTab('manual')
        return
      }
      if (data.applicant_name) setApplicantName(data.applicant_name)
      const extracted = (data.career_entries || []).map((c) => ({
        ...newEntry(),
        company_name: c.company_name || '',
        start_date: c.start_date || '',
        end_date: c.end_date || '',
        employment_type: EMPLOYMENT_TYPES.includes(c.employment_type_guess) ? c.employment_type_guess : '정규직',
        job_match: MATCH_LEVELS.includes(c.job_match_suggestion) ? c.job_match_suggestion : '',
        job_title: c.job_title || '',
        listed_bonus_eligible_job: suggestListedBonusEligible(c.job_title || ''),
      }))
      if (extracted.length > 0) {
        setEntries(extracted)
        setExpandedIds(new Set())
      }
      setTab('manual')
    } catch (err) {
      alert('업로드 처리 중 오류: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  async function safeJson(res) {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { error: `서버 응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}` }
    }
  }

  async function lookupRevenue(entryId, corpCode) {
    const entry = entries.find((e) => e.id === entryId)
    if (!entry.company_name?.trim()) {
      alert('회사명을 먼저 입력해주세요.')
      return
    }
    updateEntry(entryId, 'revenue_lookup_status', 'loading')
    updateEntry(entryId, 'revenue_lookup_message', '')
    try {
      const params = corpCode
        ? `corp_code=${encodeURIComponent(corpCode)}`
        : `company=${encodeURIComponent(entry.company_name)}`
      const res = await fetch(`/api/dart-lookup?${params}`)
      const data = await safeJson(res)

      if (data.error) {
        updateEntry(entryId, 'revenue_lookup_status', 'failed')
        updateEntry(entryId, 'revenue_lookup_message', data.error)
        return
      }
      if (data.ambiguous) {
        updateEntry(entryId, 'revenue_lookup_status', 'ambiguous')
        updateEntry(entryId, 'revenue_lookup_candidates', data.candidates)
        updateEntry(entryId, 'revenue_lookup_message', data.reason)
        return
      }
      if (!data.found || !data.revenue_found) {
        updateEntry(entryId, 'revenue_lookup_status', 'failed')
        updateEntry(entryId, 'revenue_lookup_message', data.reason || '조회 결과가 없습니다.')
        if (data.is_listed !== undefined) updateEntry(entryId, 'is_listed_hint', data.is_listed)
        if (data.market !== undefined) updateEntry(entryId, 'market_hint', data.market)
        if (data.established_date !== undefined) updateEntry(entryId, 'established_hint', data.established_date)
        return
      }

      const bracket = mapRevenueToBracket(data.revenue_amount)
      updateEntry(entryId, 'revenue_bracket', bracket)
      updateEntry(entryId, 'revenue_source', 'auto')
      updateEntry(
        entryId,
        'revenue_raw_value',
        `${formatWonToEok(data.revenue_amount)} (DART, ${data.revenue_year}년 사업보고서 기준)`
      )
      updateEntry(entryId, 'is_listed_hint', data.is_listed)
      updateEntry(entryId, 'market_hint', data.market)
      updateEntry(entryId, 'established_hint', data.established_date)
      updateEntry(entryId, 'revenue_lookup_status', 'success')
      updateEntry(entryId, 'revenue_lookup_candidates', [])
    } catch (err) {
      updateEntry(entryId, 'revenue_lookup_status', 'failed')
      updateEntry(entryId, 'revenue_lookup_message', '조회 중 오류: ' + err.message)
    }
  }

  async function runCalculation() {
    if (!config) return
    const validEntries = entries.filter((e) => e.company_name && e.start_date && e.end_date)
    if (validEntries.length === 0) {
      alert('회사명/입사일/퇴사일이 입력된 경력이 최소 1건 필요합니다.')
      return
    }

    const unconfirmed = validEntries.filter((e) => !e.job_match || !e.industry_match)
    if (unconfirmed.length > 0) {
      const names = unconfirmed.map((e) => e.company_name).join(', ')
      alert(
        `아래 경력에 "미확인" 상태인 판단항목(직무매칭/업종매칭)이 있어 계산할 수 없습니다.\n\n대상: ${names}\n\n해당 카드를 펼쳐서 항목을 확인/선택해주세요.`
      )
      return
    }

    const r = calcAll(validEntries, config)
    setResult(r)
    setSalaryBandResult(null)
    setMatchedCategory(null)

    // 계산 직후, 지원 직무 텍스트로 연봉밴드 직무군을 AI가 자동 분류하고 예상 직급/연봉범위를 매칭
    if (targetJob.trim() && salaryBands.length > 0) {
      setCategoryMatching(true)
      try {
        const res = await fetch('/api/match-job-category', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetJob }),
        })
        const data = await safeJson(res)
        if (!data.error && data.category) {
          setMatchedCategory(data.category)
          const band = findSalaryBand(salaryBands, r.roundedYears, data.category)
          setSalaryBandResult(band)
        }
      } catch {
        // 연봉밴드 매칭 실패는 경력산출 결과 자체에는 영향 없음 (참고 정보이므로)
      } finally {
        setCategoryMatching(false)
      }
    }
  }

  async function saveResult() {
    if (!result || !applicantName) {
      alert('지원자명을 입력하고 계산을 먼저 실행해주세요.')
      return
    }
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/applicants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicantName,
          targetJob,
          entries: result.perEntry,
          result,
        }),
      })
      const data = await safeJson(res)
      if (data.error) throw new Error(data.error)

      setSaveMsg('저장 완료되었습니다.')
      loadHistory()
    } catch (err) {
      setSaveMsg('저장 실패: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  async function exportPdf() {
    if (!resultRef.current) return
    const titleDiv = document.createElement('div')
    titleDiv.style.cssText = 'font-size:18px; font-weight:700; font-family:"Malgun Gothic","맑은 고딕",sans-serif; padding:0 0 12px 0; background:#fff;'
    titleDiv.textContent = `경력산출 결과 - ${applicantName || '지원자'}`
    resultRef.current.prepend(titleDiv)

    try {
      const canvas = await html2canvas(resultRef.current, { scale: 2, backgroundColor: '#ffffff' })
      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const imgWidth = pageWidth - 40
      const imgHeight = (canvas.height * imgWidth) / canvas.width
      pdf.addImage(imgData, 'PNG', 20, 20, imgWidth, imgHeight)
      pdf.save(`경력산출_${applicantName || '지원자'}.pdf`)
    } finally {
      titleDiv.remove()
    }
  }

  return (
    <div className="container">
      <h1>경력산출 자동화 시스템</h1>
      <div className="subtitle">인사기획팀 내부 전용 · v2026-08-16-02 (연봉밴드 매칭 추가)</div>

      <div className="tab-group" style={{ marginBottom: 20 }}>
        <button className={mainTab === 'calc' ? 'active' : ''} onClick={() => setMainTab('calc')}>경력산출</button>
        <button className={mainTab === 'history' ? 'active' : ''} onClick={() => { setMainTab('history'); loadHistory() }}>이력 관리 {history.length > 0 ? `(${history.length})` : ''}</button>
        <button className={mainTab === 'salary' ? 'active' : ''} onClick={() => { setMainTab('salary'); loadSalaryBands() }}>연봉밴드</button>
      </div>

      {mainTab === 'calc' && (
        <>
          <button type="button" className="criteria-toggle" style={{ marginBottom: 14 }} onClick={toggleSettings}>
            {showSettings ? '설정 관리 접기 ▲' : '⚙ 설정 관리 (판단기준 수치 수정)'}
          </button>
          {showSettings && (
            <div className="card">
              <h2>설정 관리 — 계산 기준 수치</h2>
              <p style={{ fontSize: 12, color: '#888', marginTop: -6, marginBottom: 12 }}>
                여기서 값을 바꾸면 이후 모든 계산에 즉시 반영됩니다. 신중히 수정해주세요.
              </p>
              {!settings && <p style={{ fontSize: 13, color: '#888' }}>불러오는 중...</p>}
              {settingsMsg && (
                <p style={{ fontSize: 13, color: settingsMsg.includes('실패') ? '#d0342c' : '#16794f', marginBottom: 10 }}>{settingsMsg}</p>
              )}
              {settings && (
                <>
                  <h4 style={{ fontSize: 13, marginBottom: 6 }}>직무 × 업종 매칭율 (%)</h4>
                  <div className="settings-grid">
                    {settings.jobIndustry.map((row) => {
                      const key = `ji-${row.job_match}-${row.industry_match}`
                      return (
                        <div className="settings-row" key={key}>
                          <span>{row.job_match} / {row.industry_match}</span>
                          <input
                            type="number"
                            defaultValue={row.weight_percent}
                            onChange={(ev) => setSettingsEdits((p) => ({ ...p, [key]: ev.target.value }))}
                          />
                          <button
                            className="secondary"
                            disabled={settingsSavingKey === key}
                            onClick={() => saveSettingRow('job_industry_matrix', { job_match: row.job_match, industry_match: row.industry_match }, settingsEdits[key] ?? row.weight_percent, key)}
                          >
                            {settingsSavingKey === key ? '저장중' : '저장'}
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  <h4 style={{ fontSize: 13, margin: '16px 0 6px' }}>직무 × 기업규모 매칭율 (%)</h4>
                  <div className="settings-grid">
                    {settings.jobRevenue.map((row) => {
                      const key = `jr-${row.job_match}-${row.revenue_bracket}`
                      return (
                        <div className="settings-row" key={key}>
                          <span>{row.job_match} / {row.revenue_bracket}</span>
                          <input
                            type="number"
                            defaultValue={row.weight_percent}
                            onChange={(ev) => setSettingsEdits((p) => ({ ...p, [key]: ev.target.value }))}
                          />
                          <button
                            className="secondary"
                            disabled={settingsSavingKey === key}
                            onClick={() => saveSettingRow('job_revenue_matrix', { job_match: row.job_match, revenue_bracket: row.revenue_bracket }, settingsEdits[key] ?? row.weight_percent, key)}
                          >
                            {settingsSavingKey === key ? '저장중' : '저장'}
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  <h4 style={{ fontSize: 13, margin: '16px 0 6px' }}>고용형태 계수 (%)</h4>
                  <div className="settings-grid">
                    {settings.employmentType.map((row) => {
                      const key = `et-${row.employment_type}`
                      return (
                        <div className="settings-row" key={key}>
                          <span>{row.employment_type}</span>
                          <input
                            type="number"
                            defaultValue={row.weight_percent}
                            onChange={(ev) => setSettingsEdits((p) => ({ ...p, [key]: ev.target.value }))}
                          />
                          <button
                            className="secondary"
                            disabled={settingsSavingKey === key}
                            onClick={() => saveSettingRow('employment_type_weights', { employment_type: row.employment_type }, settingsEdits[key] ?? row.weight_percent, key)}
                          >
                            {settingsSavingKey === key ? '저장중' : '저장'}
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  <h4 style={{ fontSize: 13, margin: '16px 0 6px' }}>리더십 프리미엄 / 상장가산 / 돌봄도메인 특례가산 (%)</h4>
                  <div className="settings-grid">
                    {settings.leadershipPremium && (
                      <div className="settings-row">
                        <span>리더십 프리미엄</span>
                        <input
                          type="number"
                          defaultValue={settings.leadershipPremium.weight_percent}
                          onChange={(ev) => setSettingsEdits((p) => ({ ...p, lp: ev.target.value }))}
                        />
                        <button
                          className="secondary"
                          disabled={settingsSavingKey === 'lp'}
                          onClick={() => saveSettingRow('leadership_premium_config', { id: settings.leadershipPremium.id }, settingsEdits.lp ?? settings.leadershipPremium.weight_percent, 'lp')}
                        >
                          {settingsSavingKey === 'lp' ? '저장중' : '저장'}
                        </button>
                      </div>
                    )}
                    {settings.listedBonus && (
                      <div className="settings-row">
                        <span>상장가산</span>
                        <input
                          type="number"
                          defaultValue={settings.listedBonus.weight_percent}
                          onChange={(ev) => setSettingsEdits((p) => ({ ...p, lb: ev.target.value }))}
                        />
                        <button
                          className="secondary"
                          disabled={settingsSavingKey === 'lb'}
                          onClick={() => saveSettingRow('listed_bonus_config', { id: settings.listedBonus.id }, settingsEdits.lb ?? settings.listedBonus.weight_percent, 'lb')}
                        >
                          {settingsSavingKey === 'lb' ? '저장중' : '저장'}
                        </button>
                      </div>
                    )}
                    {settings.careDomainBonus && (
                      <div className="settings-row">
                        <span>돌봄도메인 특례가산</span>
                        <input
                          type="number"
                          defaultValue={settings.careDomainBonus.weight_percent}
                          onChange={(ev) => setSettingsEdits((p) => ({ ...p, cb: ev.target.value }))}
                        />
                        <button
                          className="secondary"
                          disabled={settingsSavingKey === 'cb'}
                          onClick={() => saveSettingRow('care_domain_bonus_config', { id: settings.careDomainBonus.id }, settingsEdits.cb ?? settings.careDomainBonus.weight_percent, 'cb')}
                        >
                          {settingsSavingKey === 'cb' ? '저장중' : '저장'}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          {configWarning && (
            <div style={{ background: '#fdecea', border: '1px solid #f5b5ac', color: '#9a2f22', padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
              ⚠ {configWarning}
            </div>
          )}

          <div className="card">
            <h2>1. 지원자 정보</h2>
            <p className="upload-first-hint">📄 이력서부터 업로드해주세요 — 이름 등 기본정보가 자동으로 채워집니다.</p>

            <div className="tab-group">
              <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>이력서 업로드</button>
              <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>정형 입력</button>
            </div>
            {tab === 'upload' && (
              <div className="upload-box" onClick={() => fileInputRef.current?.click()}>
                {uploading ? '추출 중입니다...' : '클릭하여 이력서 PDF/이미지 업로드 (자동 추출)'}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </div>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              <div className="field">
                <label>지원자 이름</label>
                <input value={applicantName} onChange={(e) => setApplicantName(e.target.value)} />
              </div>
              <div className="field">
                <label>지원 직무</label>
                <input value={targetJob} onChange={(e) => setTargetJob(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="card">
            <h2>2. 경력사항</h2>
            <button type="button" className="criteria-toggle" onClick={() => setShowCriteria((v) => !v)}>
              {showCriteria ? '판단기준 접기 ▲' : '판단기준 보기 ▼'}
            </button>
            {showCriteria && (
              <div className="criteria-panel">
                <h4>직무매칭 (동일 / 유사 / 기타)</h4>
                <ul>
                  <li><b>동일</b>: 직무분류표상 같은 중분류이거나, 팀장·사업부장이 동일 직무로 판단</li>
                  <li><b>유사</b>: 같은 대분류이나 중분류 불일치, 또는 팀장·사업부장이 유사 직무로 판단</li>
                  <li><b>기타</b>: 위 기준에 해당하지 않는 다른 대분류</li>
                </ul>
                <h4>업종매칭 (동종 / 유사 / 기타)</h4>
                <ul>
                  <li><b>동종</b>: 자사 웹/앱 서비스 제공, 의료기기/용품 유통·도소매, 사회보장서비스 관련</li>
                  <li><b>유사</b>: 웹/앱 서비스이나 자사 플랫폼 아님, 유통·도소매이나 취급 재화 다름, 대행업(SI/광고대행/3PL/세무회계/콜센터 등)</li>
                  <li><b>기타</b>: 위 기준에 해당하지 않음</li>
                </ul>
                <h4>기업규모 (중소 / 중견 / 대기업)</h4>
                <ul>
                  <li>재직 당시 매출액 기준으로 판단 (DART 자동조회 또는 담당자 직접 선택). <b>필수 항목 아님</b> — 미입력 시 해당 가산 없이(0%) 계산됩니다.</li>
                  <li>매출액 기준은 법적 정확한 기업규모 판정이 아닌 실무 근사치입니다 (중소 1,500억 미만 / 중견 1,500억~1조 / 대기업 1조 이상)</li>
                  <li>대기업 계열사(자체 매출은 작지만 실질은 대기업 소속)는 아래 "대기업 계열사" 체크 시 매출액과 무관하게 대기업으로 적용됩니다</li>
                </ul>
                <h4>돌봄도메인 특례가산 (+{config?.careDomainBonus ?? '-'}%)</h4>
                <ul>
                  <li>장기요양·돌봄 관련 기관 경력은 담당자가 "돌봄도메인 특례 대상"을 체크하면, 기업규모 가산과 별개로 고정 가산율이 적용됩니다</li>
                  <li>담당자 확인 필수 (자동 판별 없음)</li>
                </ul>
                <h4>고용형태 계수</h4>
                <ul>
                  <li>{config?.employmentType?.length
                    ? config.employmentType.map((r) => `${r.employment_type} ${r.weight_percent}%`).join(' / ')
                    : '불러오는 중...'}</li>
                </ul>
                <h4>리더십 프리미엄 (+{config?.leadershipPremium ?? '-'}%)</h4>
                <ul>
                  <li>재직기간 전체가 아닌, 실제 팀장·파트장 직책을 수행한 기간에만 적용</li>
                </ul>
                <h4>상장가산 (+{config?.listedBonus ?? '-'}%)</h4>
                <ul>
                  <li>적용 대상: 재무회계 / IR / 감사대응 등 공시·감사·재무보고 업무 관련 직무</li>
                  <li>"상장가산대상"은 이력서 직무명 기반 시스템 제안이며, "실제업무확인"에 담당자가 체크해야 최종 계산에 반영됨</li>
                </ul>
                <h4>경력단절 플래그</h4>
                <ul>
                  <li>직전 경력과 90일 이상 공백 시 자동 표시 (계산에는 반영되지 않으며 담당자 판단용 참고 표시)</li>
                </ul>
                <h4>반올림(년차 환산) 규칙</h4>
                <ul>
                  <li>산출된 경력이 N.50 이하면 N년차, N.50 초과면 N+1년차로 환산</li>
                </ul>
                <h4>연봉밴드 매칭 (참고)</h4>
                <ul>
                  <li>계산 후 "지원 직무" 텍스트를 AI가 회사 연봉밴드의 직무군으로 자동 분류하고, 인정경력 년차와 매칭해 예상 직급·연봉범위를 함께 보여줍니다 (참고용, 최종 처우는 별도 협의)</li>
                </ul>
              </div>
            )}
            <div className="entry-list">
              {entries.map((e, idx) => {
                const isExpanded = expandedIds.has(e.id)
                return (
                  <div className="entry-card" key={e.id}>
                    <div className="entry-card-header" onClick={() => toggleExpand(e.id)}>
                      <div className="entry-card-header-main">
                        <span className="entry-card-title">{e.company_name || `경력 ${idx + 1} (회사명 미입력)`}</span>
                        <span className="entry-card-meta">
                          {e.start_date && e.end_date ? `${e.start_date} ~ ${e.end_date}` : '기간 미입력'}
                          {e.gap_flag && <span className="flag">경력단절 90일+</span>}
                        </span>
                      </div>
                      <span className="entry-card-toggle">{isExpanded ? '접기 ▲' : '펼치기 ▼'}</span>
                    </div>

                    {isExpanded && (
                      <div className="entry-card-body">
                        <div className="entry-field">
                          <label>회사명</label>
                          <input value={e.company_name} onChange={(ev) => updateEntry(e.id, 'company_name', ev.target.value)} />
                        </div>
                        <div className="entry-field">
                          <label>입사일</label>
                          <input type="date" value={e.start_date} onChange={(ev) => updateEntry(e.id, 'start_date', ev.target.value)} />
                        </div>
                        <div className="entry-field">
                          <label>퇴사일</label>
                          <input type="date" value={e.end_date} onChange={(ev) => updateEntry(e.id, 'end_date', ev.target.value)} />
                        </div>
                        <div className="entry-field">
                          <label>고용형태</label>
                          <select value={e.employment_type} onChange={(ev) => updateEntry(e.id, 'employment_type', ev.target.value)}>
                            {EMPLOYMENT_TYPES.map((v) => <option key={v}>{v}</option>)}
                          </select>
                        </div>
                        <div className="entry-field">
                          <label>직무매칭</label>
                          <div className="entry-revenue-row">
                            <select value={e.job_match} onChange={(ev) => updateEntry(e.id, 'job_match', ev.target.value)} className={!e.job_match ? 'unconfirmed' : ''}>
                              <option value="">미확인</option>
                              {MATCH_LEVELS.map((v) => <option key={v}>{v}</option>)}
                            </select>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => suggestJobMatch(e.id)}
                              disabled={e.job_match_suggesting}
                            >
                              {e.job_match_suggesting ? '제안중...' : 'AI 제안'}
                            </button>
                          </div>
                          {e.job_title && <div className="entry-field-hint">이력서상 직무: {e.job_title}</div>}
                        </div>
                        <div className="entry-field">
                          <label>업종매칭</label>
                          <select value={e.industry_match} onChange={(ev) => updateEntry(e.id, 'industry_match', ev.target.value)} className={!e.industry_match ? 'unconfirmed' : ''}>
                            <option value="">미확인</option>
                            <option value="동종">동종</option><option value="유사">유사</option><option value="기타">기타</option>
                          </select>
                          {(e.market_hint || e.established_hint) && (
                            <div className="entry-field-hint">
                              참고: {e.market_hint || '비상장'}
                              {e.established_hint && ` · 설립 ${e.established_hint.slice(0, 4)}-${e.established_hint.slice(4, 6)}-${e.established_hint.slice(6, 8)}`}
                            </div>
                          )}
                        </div>
                        <div className="entry-field">
                          <label>돌봄도메인 특례</label>
                          <label className="entry-checkbox-row">
                            <input type="checkbox" checked={e.care_domain_confirmed} onChange={(ev) => updateEntry(e.id, 'care_domain_confirmed', ev.target.checked)} />
                            <span>담당자 확인 (특례 대상)</span>
                          </label>
                        </div>
                        <div className="entry-field">
                          <label>팀장 시작</label>
                          <input type="date" value={e.leadership_start_date} onChange={(ev) => updateEntry(e.id, 'leadership_start_date', ev.target.value)} />
                        </div>
                        <div className="entry-field">
                          <label>팀장 종료</label>
                          <input type="date" value={e.leadership_end_date} onChange={(ev) => updateEntry(e.id, 'leadership_end_date', ev.target.value)} />
                        </div>

                        <div className="entry-field entry-field-full">
                          <label>기업규모 (매출 기준, 선택)</label>
                          <div className="entry-revenue-row">
                            <select
                              value={e.revenue_bracket}
                              onChange={(ev) => { updateEntry(e.id, 'revenue_bracket', ev.target.value); updateEntry(e.id, 'revenue_source', 'manual') }}
                              disabled={e.is_conglomerate_affiliate}
                            >
                              <option value="">미입력</option>
                              {REVENUE_BRACKETS.map((v) => <option key={v}>{v}</option>)}
                            </select>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => lookupRevenue(e.id)}
                              disabled={e.revenue_lookup_status === 'loading' || e.is_conglomerate_affiliate}
                            >
                              {e.revenue_lookup_status === 'loading' ? '조회중...' : 'DART 조회'}
                            </button>
                            {e.is_listed_hint !== null && (
                              <span className="flag" style={{ background: e.is_listed_hint ? '#dcf5e4' : '#eee', color: e.is_listed_hint ? '#16794f' : '#666' }}>
                                {e.is_listed_hint ? '상장사' : '비상장'}
                              </span>
                            )}
                          </div>
                          <label className="entry-checkbox-row" style={{ marginTop: 6 }}>
                            <input
                              type="checkbox"
                              checked={e.is_conglomerate_affiliate}
                              onChange={(ev) => {
                                updateEntry(e.id, 'is_conglomerate_affiliate', ev.target.checked)
                                if (ev.target.checked) updateEntry(e.id, 'revenue_source', 'manual')
                              }}
                            />
                            <span>대기업 계열사 (담당자 확인 — 체크 시 매출액과 무관하게 대기업 적용)</span>
                          </label>
                          {e.revenue_source === 'auto' && <div className="entry-field-hint">{e.revenue_raw_value}</div>}
                          {e.revenue_lookup_status === 'failed' && <div className="entry-field-hint entry-field-hint-error">{e.revenue_lookup_message}</div>}
                          {e.revenue_lookup_status === 'ambiguous' && (
                            <div style={{ marginTop: 4 }}>
                              <div className="entry-field-hint entry-field-hint-warn">{e.revenue_lookup_message}</div>
                              {e.revenue_lookup_candidates.map((c) => (
                                <button
                                  key={c.corp_code}
                                  type="button"
                                  className="secondary"
                                  style={{ display: 'block', padding: '4px 8px', fontSize: 12, marginTop: 4, width: '100%' }}
                                  onClick={() => lookupRevenue(e.id, c.corp_code)}
                                >
                                  {c.corp_name} {c.stock_code ? `(${c.stock_code})` : '(비상장)'}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="entry-field">
                          <label>상장가산대상</label>
                          <label className="entry-checkbox-row">
                            <input type="checkbox" checked={e.listed_bonus_eligible_job} onChange={(ev) => updateEntry(e.id, 'listed_bonus_eligible_job', ev.target.checked)} />
                            <span>시스템 제안 대상</span>
                          </label>
                        </div>
                        <div className="entry-field">
                          <label>실제업무확인</label>
                          <label className="entry-checkbox-row">
                            <input type="checkbox" checked={e.listed_bonus_confirmed} onChange={(ev) => updateEntry(e.id, 'listed_bonus_confirmed', ev.target.checked)} disabled={!e.listed_bonus_eligible_job} />
                            <span>담당자 최종 확인</span>
                          </label>
                        </div>

                        <div className="entry-field-full entry-card-footer">
                          <button type="button" className="danger" onClick={() => removeEntry(e.id)}>이 경력 삭제</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="btn-row">
              <button className="secondary" onClick={addEntry}>+ 경력 추가</button>
            </div>
            <p style={{ fontSize: 12, color: '#888', marginTop: 10 }}>
              ※ 직무매칭/업종매칭은 기본값이 없고 "미확인"(노란색 표시) 상태로 시작하며, 담당자가 직접 판단해서 선택해야 계산이 진행됩니다.
              기업규모(매출 기준)는 필수 항목이 아닙니다 — 미입력 상태로도 계산이 가능하며, 이 경우 기업규모 관련 가산만 0%로 처리됩니다.
              "DART 조회" 버튼으로 매출액 자동조회가 가능합니다 (상장사·외부감사대상 비상장사만 조회됨, 지원 시점 기준 직전 확정 사업연도 기준). 조회 실패 시 직접 선택하거나 비워두어도 됩니다.
              동일 이름의 회사가 여러 건이면 후보 목록에서 선택할 수 있습니다.
              대기업 계열사는 체크 시 매출액 조회와 무관하게 기업규모가 대기업으로 고정 적용됩니다.
              돌봄도메인 특례는 담당자가 직접 확인 후 체크해야 하며, 체크 시 기업규모 가산과 별개로 고정 가산율이 추가 적용됩니다.
              상장가산 대상 여부는 이력서 직무명을 기반으로 제안되며, 최종 확정은 담당자가 실제 업무수행을 확인한 뒤 체크해야 합니다.
              직무매칭은 이력서에서 추출된 직무명과 상단 "지원 직무"를 "AI 제안" 버튼을 누른 시점에 비교해서 제안합니다 (지원 직무를 수정한 뒤 다시 눌러도 재비교됩니다). 이력서 업로드 없이 직접 추가한 경력은 비교할 원문이 없어 AI 제안을 쓸 수 없으니 직접 선택해주세요. 최종 판단은 담당자가 확인 후 수정해주세요.
            </p>
          </div>

          <div className="card">
            <h2>3. 계산 결과</h2>
            <div className="btn-row" style={{ marginTop: 0, marginBottom: 14 }}>
              <button onClick={runCalculation} disabled={!config}>계산하기</button>
              {result && <button className="secondary" onClick={exportPdf}>PDF 내보내기</button>}
              {result && <button className="secondary" onClick={saveResult} disabled={saving}>{saving ? '저장 중...' : '저장'}</button>}
            </div>
            {saveMsg && <p style={{ fontSize: 13, color: saveMsg.includes('실패') ? '#d0342c' : '#16794f' }}>{saveMsg}</p>}
            {result && result.perEntry.some((e) => !e.revenue_bracket && !e.is_conglomerate_affiliate) && (
              <p style={{ fontSize: 13, color: '#9a6b16', background: '#fff8e6', border: '1px solid #f0dca0', borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>
                ⚠ 일부 경력이 기업규모 미입력 상태로 계산되었습니다 (해당 경력의 기업규모 가산 0% 반영).
              </p>
            )}

            {result && (
              <div ref={resultRef}>
                <div className="result-summary">{result.roundedYears}년차 (인정경력 {result.totalYears.toFixed(2)}년)</div>

                {categoryMatching && (
                  <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>연봉밴드 매칭 중...</p>
                )}
                {!categoryMatching && salaryBands.length === 0 && (
                  <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>연봉밴드 데이터가 업로드되지 않아 예상 직급/연봉은 표시되지 않습니다 ("연봉밴드" 탭에서 업로드 가능).</p>
                )}
                {!categoryMatching && salaryBandResult && (
                  <div className="salary-band-result">
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>지원 직무 → 직무군 자동분류: <b>{matchedCategory}</b></div>
                    {salaryBandResult.noData ? (
                      <div style={{ color: '#9a6b16' }}>
                        {salaryBandResult.executive ? `임원급(${salaryBandResult.grade || '이사 이상'}) 구간으로, 연봉밴드 데이터가 준비되어 있지 않습니다.` : '해당 구간의 연봉밴드 데이터가 없습니다.'}
                      </div>
                    ) : (
                      <div className="salary-band-box">
                        <span>예상 직급: <b>{salaryBandResult.grade}{salaryBandResult.step}호봉</b></span>
                        <span>예상 연봉범위: <b>{salaryBandResult.minSalary.toLocaleString('ko-KR')}천원 ~ {salaryBandResult.maxSalary.toLocaleString('ko-KR')}천원</b></span>
                        {salaryBandResult.exceededTable && <span style={{ color: '#9a6b16' }}>(테이블 최대 년차를 초과해 최대 구간 기준으로 표시됨)</span>}
                      </div>
                    )}
                  </div>
                )}

                <table style={{ marginTop: 14 }}>
                  <thead>
                    <tr><th>회사명</th><th>기간</th><th>인정연수</th><th>비고</th></tr>
                  </thead>
                  <tbody>
                    {result.perEntry.map((e) => (
                      <tr key={e.id}>
                        <td>{e.company_name}</td>
                        <td>{e.start_date} ~ {e.end_date}</td>
                        <td>{e.calc.entryYears.toFixed(2)}년</td>
                        <td>{e.gap_flag && <span className="flag">경력단절 90일+</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {mainTab === 'history' && (
        <div className="card">
          <h2>최근 산출 이력</h2>
          {history.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>저장된 이력이 없습니다.</p>}
          {history.length > 0 && (
            <>
              <div className="btn-row" style={{ marginTop: 0, marginBottom: 10 }}>
                <button
                  className="danger"
                  disabled={selectedHistoryIds.size === 0 || historyDeleting}
                  onClick={deleteSelectedHistory}
                >
                  {historyDeleting ? '삭제 중...' : `선택 삭제 (${selectedHistoryIds.size})`}
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>
                        <input
                          type="checkbox"
                          checked={selectedHistoryIds.size === history.length}
                          onChange={(ev) => setSelectedHistoryIds(ev.target.checked ? new Set(history.map((h) => h.id)) : new Set())}
                        />
                      </th>
                      <th>이름</th><th>직무군</th><th>인정경력</th><th>날짜</th><th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => {
                      const isExpanded = expandedHistoryIds.has(h.id)
                      const snapshot = h.calc_snapshot
                      return (
                        <React.Fragment key={h.id}>
                          <tr>
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedHistoryIds.has(h.id)}
                                onChange={() => toggleHistorySelect(h.id)}
                              />
                            </td>
                            <td>{h.applicants?.name || '(이름없음)'}</td>
                            <td>{h.applicants?.target_job || '-'}</td>
                            <td>{h.rounded_years}년차 ({Number(h.total_recognized_years).toFixed(2)}년)</td>
                            <td>{new Date(h.calculated_at).toLocaleDateString('ko-KR')}</td>
                            <td>
                              <button
                                type="button"
                                className="secondary"
                                style={{ padding: '4px 10px', fontSize: 12 }}
                                onClick={() => toggleHistoryExpand(h.id)}
                                disabled={!snapshot}
                              >
                                {isExpanded ? '접기' : '상세'}
                              </button>
                            </td>
                          </tr>
                          {isExpanded && snapshot && (
                            <tr>
                              <td colSpan={6} style={{ background: '#fafafa', padding: 14 }}>
                                {(snapshot.perEntry || []).map((entry) => (
                                  <HistoryEntryDetail key={entry.id} entry={entry} />
                                ))}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {mainTab === 'salary' && (
        <div className="card">
          <h2>연봉밴드 관리</h2>
          <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
            인사기획팀에서 관리하는 직급/연봉밴드 엑셀을 업로드하면, 경력산출 결과(인정경력 년차)와 지원 직무를 매칭해 예상 직급·연봉범위를 자동으로 보여줍니다.
            업데이트 시 새 엑셀을 다시 업로드하면 기존 데이터를 전부 교체합니다.
          </p>
          <div className="btn-row" style={{ marginTop: 0, marginBottom: 10 }}>
            <button onClick={() => salaryFileInputRef.current?.click()} disabled={salaryUploading}>
              {salaryUploading ? '업로드 중...' : '엑셀 업로드'}
            </button>
            <button className="secondary" onClick={downloadSalaryXlsx} disabled={salaryBands.length === 0}>
              현재 데이터 엑셀 다운로드
            </button>
            <input
              ref={salaryFileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleSalaryUpload}
            />
          </div>
          {salaryMsg && <p style={{ fontSize: 13, color: salaryMsg.includes('실패') ? '#d0342c' : '#16794f', marginBottom: 10 }}>{salaryMsg}</p>}
          {salaryLastUpload && (
            <p style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
              마지막 업로드: {salaryLastUpload.filename || '(파일명 없음)'} · {new Date(salaryLastUpload.uploaded_at).toLocaleString('ko-KR')} · {salaryLastUpload.row_count}건
            </p>
          )}

          {salaryBands.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>업로드된 연봉밴드 데이터가 없습니다.</p>}
          {salaryBands.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr><th>직급</th><th>년차</th><th>호봉</th><th>직무군</th><th>세부직무</th><th>MIN(천원)</th><th>MAX(천원)</th></tr>
                </thead>
                <tbody>
                  {salaryBands.map((row) => {
                    const minKey = row.id + 'min'
                    const maxKey = row.id + 'max'
                    return (
                      <tr key={row.id}>
                        <td>{row.grade}</td>
                        <td>{row.year_num}년차</td>
                        <td>{row.step}</td>
                        <td>{row.category}</td>
                        <td style={{ fontSize: 12, color: '#666' }}>{row.job_functions || '-'}</td>
                        <td>
                          <div className="salary-edit-cell">
                            <input
                              type="number"
                              defaultValue={row.min_salary ?? ''}
                              placeholder="-"
                              style={{ width: 80 }}
                              onChange={(ev) => setSalaryEdits((p) => ({ ...p, [minKey]: ev.target.value }))}
                            />
                            <button
                              className="secondary"
                              style={{ padding: '2px 8px', fontSize: 11 }}
                              disabled={salaryRowSavingId === minKey}
                              onClick={() => saveSalaryBandRow(row.id, 'min_salary', salaryEdits[minKey] ?? row.min_salary)}
                            >
                              {salaryRowSavingId === minKey ? '저장중' : '저장'}
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="salary-edit-cell">
                            <input
                              type="number"
                              defaultValue={row.max_salary ?? ''}
                              placeholder="-"
                              style={{ width: 80 }}
                              onChange={(ev) => setSalaryEdits((p) => ({ ...p, [maxKey]: ev.target.value }))}
                            />
                            <button
                              className="secondary"
                              style={{ padding: '2px 8px', fontSize: 11 }}
                              disabled={salaryRowSavingId === maxKey}
                              onClick={() => saveSalaryBandRow(row.id, 'max_salary', salaryEdits[maxKey] ?? row.max_salary)}
                            >
                              {salaryRowSavingId === maxKey ? '저장중' : '저장'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
