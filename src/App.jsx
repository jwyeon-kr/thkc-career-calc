import React, { useState, useEffect, useRef } from 'react'
import { loadWeightConfig, calcAll } from './lib/calculator'
import { mapRevenueToBracket, formatWonToEok } from '../shared/revenueBracket'
import { suggestListedBonusEligible } from '../shared/listedBonusJobs'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

const EMPLOYMENT_TYPES = ['정규직', '계약직', '파견', '인턴']
const MATCH_LEVELS = ['동일', '유사', '기타']
const REVENUE_BRACKETS = ['3000억이상', '3000억미만', '당사미만', '+500억', '50억미만']

function newEntry() {
  return {
    id: crypto.randomUUID(),
    company_name: '',
    start_date: '',
    end_date: '',
    employment_type: '정규직',
    job_match: '동일',
    industry_match: '동종',
    revenue_bracket: '당사미만',
    revenue_source: 'manual',
    revenue_raw_value: '',
    care_domain_match: '기타',
    leadership_start_date: '',
    leadership_end_date: '',
    listed_bonus_eligible_job: false,
    listed_bonus_confirmed: false,
    job_title: '', // 정형입력 시 직무매칭 AI제안용 (DB 저장 안 함, 화면 전용)
    // 아래는 화면 표시용 임시 상태 (DB 저장 안 함)
    revenue_lookup_status: 'idle', // idle | loading | success | failed | ambiguous
    revenue_lookup_message: '',
    revenue_lookup_candidates: [],
    is_listed_hint: null,
    market_hint: null,
    established_hint: null,
  }
}

export default function App() {
  const [applicantName, setApplicantName] = useState('')
  const [targetJob, setTargetJob] = useState('')
  const [firstEntry] = useState(() => newEntry())
  const [entries, setEntries] = useState([firstEntry])
  const [expandedIds, setExpandedIds] = useState(() => new Set([firstEntry.id]))
  const [config, setConfig] = useState(null)
  const [result, setResult] = useState(null)
  const [tab, setTab] = useState('manual') // manual | upload
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
  const resultRef = useRef(null)
  const fileInputRef = useRef(null)

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
  }, [])

  async function loadHistory() {
    try {
      const res = await fetch('/api/applicants')
      const data = await res.json()
      setHistory(data.history || [])
    } catch {
      setHistory([])
    }
  }

  function updateEntry(id, field, value) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)))
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings')
      const data = await res.json()
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
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setSettingsMsg('저장되었습니다.')
      loadSettings()
      loadWeightConfig().then(setConfig) // 화면의 계산 로직도 즉시 최신값으로 갱신
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
      const data = await res.json()
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
      alert('이 경력의 "담당 직무명"을 입력해주세요.')
      return
    }
    updateEntry(entryId, 'job_match_suggesting', true)
    try {
      const res = await fetch('/api/match-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetJob, jobTitle: entry.job_title }),
      })
      const data = await res.json()
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
      const base64 = await fileToBase64(file)
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data: base64, mediaType: file.type, targetJob }),
      })
      const data = await res.json()
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
        job_match: MATCH_LEVELS.includes(c.job_match_suggestion) ? c.job_match_suggestion : '동일',
        listed_bonus_eligible_job: suggestListedBonusEligible(c.job_title || ''),
      }))
      if (extracted.length > 0) {
        setEntries(extracted)
        setExpandedIds(new Set()) // 추출된 항목은 요약만 보이도록 접어서 시작 (필요한 것만 펼쳐 확인)
      }
      setTab('manual')
    } catch (err) {
      alert('업로드 처리 중 오류: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result.split(',')[1])
      r.onerror = reject
      r.readAsDataURL(file)
    })
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
      const data = await res.json()

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
  function runCalculation() {
    if (!config) return
    const validEntries = entries.filter((e) => e.company_name && e.start_date && e.end_date)
    if (validEntries.length === 0) {
      alert('회사명/입사일/퇴사일이 입력된 경력이 최소 1건 필요합니다.')
      return
    }
    const r = calcAll(validEntries, config)
    setResult(r)
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
      const data = await res.json()
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
    // jsPDF의 기본 폰트는 한글을 지원하지 않아 pdf.text()로 한글을 쓰면 깨짐.
    // 제목까지 포함한 화면을 통째로 캡처(이미지화)하여 폰트 문제를 원천 차단.
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
      <div className="subtitle">인사기획팀 내부 전용 · v2026-08-15-09 (설정관리/이력삭제/직무매칭/DART캐시)</div>
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

              <h4 style={{ fontSize: 13, margin: '16px 0 6px' }}>직무 × 매출구간 매칭율 (%)</h4>
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

              <h4 style={{ fontSize: 13, margin: '16px 0 6px' }}>리더십 프리미엄 / 상장가산 (%)</h4>
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

      {/* 1. 지원자 정보 + 업로드 */}
      <div className="card">
        <h2>1. 지원자 정보</h2>
        <div className="row">
          <div className="field">
            <label>지원자 이름</label>
            <input value={applicantName} onChange={(e) => setApplicantName(e.target.value)} />
          </div>
          <div className="field">
            <label>지원 직무</label>
            <input value={targetJob} onChange={(e) => setTargetJob(e.target.value)} />
          </div>
        </div>

        <div className="tab-group">
          <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>정형 입력</button>
          <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>이력서 업로드</button>
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
      </div>

      {/* 2. 경력사항 */}
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
            <h4>매출구간</h4>
            <ul>
              <li>재직 당시 매출액 기준으로 판단 (3000억이상 / 3000억미만 / 당사미만 / +500억 / 50억미만)</li>
              <li>복지법인/재단 등 비영리기관 경력자는 원칙적으로 낮은 구간 적용</li>
              <li>단, 장기요양 관련 기관 경력은 "당사미만" 구간 적용 → 아래 돌봄도메인 특례로 자동 반영</li>
            </ul>
            <h4>돌봄도메인 (동일 / 유사 / 기타)</h4>
            <ul>
              <li><b>동일</b> 선택 시, 매출구간이 자동으로 "당사미만"으로 완화 적용됩니다 (장기요양기관 특례)</li>
              <li>유사/기타는 현재 특별 처리 없음 (필드만 기록, 추후 데이터 축적 후 차등 검토 예정)</li>
            </ul>
            <h4>고용형태 계수</h4>
            <ul>
              <li>정규직 100% / 계약직 85% / 파견 75% / 인턴 40%</li>
            </ul>
            <h4>리더십 프리미엄 (+10%)</h4>
            <ul>
              <li>재직기간 전체가 아닌, 실제 팀장·파트장 직책을 수행한 기간에만 적용</li>
            </ul>
            <h4>상장가산 (+10%)</h4>
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
                      <label>담당 직무명</label>
                      <input
                        placeholder="예: 인사기획 팀장"
                        value={e.job_title}
                        onChange={(ev) => updateEntry(e.id, 'job_title', ev.target.value)}
                      />
                    </div>
                    <div className="entry-field">
                      <label>직무매칭</label>
                      <div className="entry-revenue-row">
                        <select value={e.job_match} onChange={(ev) => updateEntry(e.id, 'job_match', ev.target.value)}>
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
                    </div>
                    <div className="entry-field">
                      <label>업종매칭</label>
                      <select value={e.industry_match} onChange={(ev) => updateEntry(e.id, 'industry_match', ev.target.value)}>
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
                      <label>돌봄도메인</label>
                      <select value={e.care_domain_match} onChange={(ev) => updateEntry(e.id, 'care_domain_match', ev.target.value)}>
                        {MATCH_LEVELS.map((v) => <option key={v}>{v}</option>)}
                      </select>
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
                      <label>매출구간</label>
                      <div className="entry-revenue-row">
                        <select value={e.revenue_bracket} onChange={(ev) => { updateEntry(e.id, 'revenue_bracket', ev.target.value); updateEntry(e.id, 'revenue_source', 'manual') }}>
                          {REVENUE_BRACKETS.map((v) => <option key={v}>{v}</option>)}
                        </select>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => lookupRevenue(e.id)}
                          disabled={e.revenue_lookup_status === 'loading'}
                        >
                          {e.revenue_lookup_status === 'loading' ? '조회중...' : 'DART 조회'}
                        </button>
                        {e.is_listed_hint !== null && (
                          <span className="flag" style={{ background: e.is_listed_hint ? '#dcf5e4' : '#eee', color: e.is_listed_hint ? '#16794f' : '#666' }}>
                            {e.is_listed_hint ? '상장사' : '비상장'}
                          </span>
                        )}
                      </div>
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
          ※ "DART 조회" 버튼으로 매출액 자동조회가 가능합니다 (상장사·외부감사대상 비상장사만 조회됨. 조회 실패 시 직접 선택해주세요).
          동일 이름의 회사가 여러 건이면 후보 목록에서 선택할 수 있습니다.
          복지법인/장기요양기관 특례는 돌봄도메인을 "동일"로 선택하면 자동 반영됩니다.
          상장가산 대상 여부는 이력서 직무명을 기반으로 제안되며, 최종 확정은 담당자가 실제 업무수행을 확인한 뒤 체크해야 합니다.
          이력서 업로드 시 직무매칭(동일/유사/기타)도 지원직무와 비교하여 AI가 제안하지만, 최종 판단은 담당자가 확인 후 수정해주세요.
        </p>
      </div>

      {/* 3. 계산 결과 */}
      <div className="card">
        <h2>3. 계산 결과</h2>
        <div className="btn-row" style={{ marginTop: 0, marginBottom: 14 }}>
          <button onClick={runCalculation} disabled={!config}>계산하기</button>
          {result && <button className="secondary" onClick={exportPdf}>PDF 내보내기</button>}
          {result && <button className="secondary" onClick={saveResult} disabled={saving}>{saving ? '저장 중...' : '저장'}</button>}
        </div>
        {saveMsg && <p style={{ fontSize: 13, color: saveMsg.includes('실패') ? '#d0342c' : '#16794f' }}>{saveMsg}</p>}

        {result && (
          <div ref={resultRef}>
            <div className="result-summary">{result.roundedYears}년차 (인정경력 {result.totalYears.toFixed(2)}년)</div>
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

      {/* 4. 이력 조회 */}
      <div className="card">
        <h2>4. 최근 산출 이력</h2>
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
                    <th>이름</th><th>직무군</th><th>인정경력</th><th>날짜</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
