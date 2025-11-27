import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import axios from 'axios'
import { formatDistanceToNow } from 'date-fns'
import ForceGraph2D from 'react-force-graph-2d'
import './App.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY
const QUICKNODE_RPC = import.meta.env.VITE_QUICKNODE_RPC
const SECRET_CODE = import.meta.env.VITE_SECRET_CODE

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function App() {
  const [wallets, setWallets] = useState([])
  const [selectedWallet, setSelectedWallet] = useState(null)
  const [accumulatedFlows, setAccumulatedFlows] = useState([]) // 자금 흐름 로그
  
  const [newAddress, setNewAddress] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)

  // Graph State
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const mapRef = useRef(null)
  const fgRef = useRef()

  // 중복 분석 방지용
  const analyzedSigs = useRef(new Set())

  useEffect(() => {
    fetchWallets()
    const handleResize = () => {
      if (mapRef.current) {
        setDimensions({
          width: mapRef.current.offsetWidth,
          height: mapRef.current.offsetHeight
        })
      }
    }
    window.addEventListener('resize', handleResize)
    setTimeout(handleResize, 1000)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const fetchWallets = async () => {
    const { data } = await supabase.from('tracked_wallets').select('*').order('created_at', { ascending: false })
    if (data) setWallets(data)
  }

  const addWallet = async () => {
    const code = prompt("ENTER SECURITY CODE:")
    if (code !== SECRET_CODE) return alert("DENIED")
    if (!newAddress) return
    const { error } = await supabase.from('tracked_wallets').insert([{ address: newAddress, label: newLabel || 'Target' }])
    if (!error) { setNewAddress(''); setNewLabel(''); fetchWallets(); }
    else alert(error.message)
  }

  // ★ 핵심 로직: 트랜잭션 내 자금 흐름 정밀 분석 (SOL + SPL)
  const analyzeTransactionFlows = (tx, signature, blockTime) => {
    const flows = []
    if (!tx || !tx.meta) return flows

    const { meta, transaction } = tx
    const accountKeys = transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey)
    
    // 1. SPL Token 분석 (preTokenBalances vs postTokenBalances)
    // Owner별로 묶어서 계산 (ATA가 달라도 Owner가 같으면 같은 지갑)
    const tokenChanges = new Map() // Key: Owner, Value: { mint, delta, decimals }

    const processTokenBalances = (balances, isPost) => {
        if (!balances) return
        balances.forEach(entry => {
            const owner = entry.owner || accountKeys[entry.accountIndex] // Owner가 없으면 AccountKey 사용
            const mint = entry.mint
            const amount = parseFloat(entry.uiTokenAmount.uiAmount || 0)
            
            const key = `${owner}-${mint}`
            if (!tokenChanges.has(key)) tokenChanges.set(key, { owner, mint, diff: 0 })
            
            const data = tokenChanges.get(key)
            data.diff += isPost ? amount : -amount
        })
    }

    processTokenBalances(meta.preTokenBalances, false)
    processTokenBalances(meta.postTokenBalances, true)

    // 토큰 흐름 추출
    tokenChanges.forEach((val) => {
        // 0.000001 이상 변화가 있을 때만 흐름으로 인정 (먼지 팁 제외)
        if (Math.abs(val.diff) > 0.000001) {
            flows.push({
                type: 'SPL',
                owner: val.owner,
                mint: val.mint,
                amount: val.diff,
                signature,
                blockTime
            })
        }
    })

    // 2. Native SOL 분석 (preBalances vs postBalances)
    meta.postBalances.forEach((post, idx) => {
        const pre = meta.preBalances[idx]
        const diffLamports = post - pre
        const diffSol = diffLamports / 1000000000
        const address = accountKeys[idx]

        // 수수료(Fee)로 나간 건 제외하기 위해 약간의 마진을 둠 (대량 전송만 추적)
        // 혹은 FeePayer가 낸 수수료라고 명시적으로 처리할 수도 있음
        // 여기서는 0.001 SOL 이상 변동만 유의미한 이동으로 간주
        if (Math.abs(diffSol) > 0.001) {
             // 토큰 계정이 아닌 일반 계정(System Program 소유)일 확률이 높음
             flows.push({
                type: 'SOL',
                owner: address,
                mint: 'SOL',
                amount: diffSol,
                signature,
                blockTime
            })
        }
    })

    return flows
  }

  // ★ 탐색 및 그래프 확장 함수
  const exploreAddress = async (address, label, isExpand = false) => {
    setDetailLoading(true)
    
    // 그래프 임시 저장소
    const newNodes = []
    const newLinks = []
    const newFlowLogs = []
    
    // 현재 그래프에 이미 있는 노드 ID들 (중복 생성 방지)
    const existingIds = new Set(isExpand ? graphData.nodes.map(n => n.id) : [])

    // 루트 노드(탐색 대상) 추가
    if (!existingIds.has(address)) {
        newNodes.push({ id: address, group: 'target', label: label || address.slice(0,4), val: 40 })
        existingIds.add(address)
    }

    try {
      // 1. 최근 트랜잭션 서명 가져오기 (Limit 10으로 상향)
      const sigRes = await axios.post(QUICKNODE_RPC, {
        jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
        params: [address, { limit: 10 }] 
      })
      const sigs = sigRes.data.result || []

      // 2. 각 트랜잭션 상세 조회 (병렬 처리)
      const txPromises = sigs.map(async (sigItem) => {
        if (analyzedSigs.current.has(sigItem.signature)) return null // 이미 분석한 TX 패스
        
        analyzedSigs.current.add(sigItem.signature)

        const txRes = await axios.post(QUICKNODE_RPC, {
            jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [sigItem.signature, { maxSupportedTransactionVersion: 0 }]
        })
        return { data: txRes.data.result, sig: sigItem.signature, time: sigItem.blockTime }
      })

      const txResults = await Promise.all(txPromises)

      // 3. 자금 흐름 분석 및 그래프 매핑
      txResults.forEach(res => {
        if (!res || !res.data) return
        
        // 정밀 분석 실행
        const flows = analyzeTransactionFlows(res.data, res.sig, res.time)
        
        // 흐름이 없으면 스킵 (단순 승인/투표 트랜잭션 등)
        if (flows.length === 0) return

        // TX 노드 생성
        if (!existingIds.has(res.sig)) {
            newNodes.push({ id: res.sig, group: 'tx', val: 5 })
            existingIds.add(res.sig)
        }

        // Sender(보낸 사람)와 Receiver(받은 사람) 분리
        const senders = flows.filter(f => f.amount < 0)
        const receivers = flows.filter(f => f.amount > 0)

        // 그래프 엣지 연결: Sender -> TX -> Receiver
        // 이 구조가 있어야 "누가 누구에게 줬는지" 시각적으로 보임
        
        // (1) Sender -> TX 링크
        senders.forEach(sender => {
            // 노드 없으면 추가 (Sender)
            if (!existingIds.has(sender.owner)) {
                newNodes.push({ id: sender.owner, group: 'wallet', label: 'Sender', val: 20 })
                existingIds.add(sender.owner)
            }
            
            newLinks.push({
                source: sender.owner,
                target: res.sig,
                label: `${Math.abs(sender.amount).toFixed(2)} ${sender.mint === 'So11111111111111111111111111111111111111112' ? 'WSOL' : sender.mint.slice(0,3)}`,
                color: '#ff0055' // 빨간색 (출금)
            })
        })

        // (2) TX -> Receiver 링크
        receivers.forEach(receiver => {
             // 노드 없으면 추가 (Receiver)
             if (!existingIds.has(receiver.owner)) {
                newNodes.push({ id: receiver.owner, group: 'wallet', label: 'Receiver', val: 20 })
                existingIds.add(receiver.owner)
            }

            // 로그용 데이터 저장
            newFlowLogs.push({
                time: res.time,
                sig: res.sig,
                from: senders.map(s => s.owner).join(', ') || 'Unknown', // 다수의 Sender일 수 있음
                to: receiver.owner,
                amount: `${receiver.amount.toFixed(4)} ${receiver.mint === 'So11111111111111111111111111111111111111112' ? 'WSOL' : receiver.mint.slice(0,4)}`
            })

            newLinks.push({
                source: res.sig,
                target: receiver.owner,
                label: `${receiver.amount.toFixed(2)}`, // 받는 금액
                color: '#00ff9d' // 초록색 (입금)
            })
        })
      })

      // 상태 업데이트
      if (isExpand) {
          setGraphData(prev => ({
              nodes: [...prev.nodes, ...newNodes],
              links: [...prev.links, ...newLinks]
          }))
          setAccumulatedFlows(prev => [...newFlowLogs, ...prev])
      } else {
          setGraphData({ nodes: newNodes, links: newLinks })
          setAccumulatedFlows(newFlowLogs)
      }

    } catch (e) {
      console.error("Explore Error:", e)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleWalletClick = (wallet) => {
    setSelectedWallet(wallet)
    analyzedSigs.current.clear() // 초기화 시 분석 캐시도 초기화
    exploreAddress(wallet.address, wallet.label, false)
  }

  const handleNodeClick = (node) => {
    if (node.group === 'wallet' || node.group === 'target') {
        if (window.confirm(`Trace funds from/to ${node.id}?`)) {
            exploreAddress(node.id, "Trace", true)
        }
    } else if (node.group === 'tx') {
        window.open(`https://solscan.io/tx/${node.id}`, '_blank')
    }
  }

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
    alert(`Copied: ${text}`)
  }

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="brand">⚡ SOL FORENSIC V2</div>
        <div className="add-box">
          <input className="input-dark" placeholder="Addr" value={newAddress} onChange={e=>setNewAddress(e.target.value)} />
          <input className="input-dark" placeholder="Label" value={newLabel} onChange={e=>setNewLabel(e.target.value)} />
          <button className="btn-neon" onClick={addWallet}>ADD TARGET</button>
        </div>
        <div className="list-header">INVESTIGATION TARGETS</div>
        <div className="list-area">
          {wallets.map(w => (
            <div 
                key={w.id} 
                className={`list-item ${selectedWallet?.address === w.address ? 'active' : ''}`}
                onClick={() => handleWalletClick(w)}
            >
              <span className="l-label">{w.label}</span>
              <span className="l-addr">{w.address.slice(0,10)}...</span>
            </div>
          ))}
        </div>
      </aside>

      <div className="center-panel">
        <div className="map-section" ref={mapRef}>
            <div className="section-title">
                <span>MONEY FLOW GRAPH (SOL & SPL)</span>
                {detailLoading && <span className="blink"> TRACING ON-CHAIN DATA...</span>}
            </div>
            
            [Image of Solana Transaction Anatomy]

            <ForceGraph2D
                ref={fgRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                backgroundColor="#050505"
                // 노드 스타일링
                nodeLabel={node => `${node.group}: ${node.id}`} 
                nodeColor={node => {
                    if(node.group === 'target') return '#00b8ff' // Blue (Target)
                    if(node.group === 'tx') return '#666' // Gray (Transaction Hub)
                    return '#bd00ff' // Purple (Wallet/Owner)
                }}
                nodeRelSize={6}
                // 링크(Edge) 스타일링 - 금액 표시
                linkLabel={link => link.label}
                linkWidth={link => link.group === 'tx' ? 0 : 1.5}
                linkDirectionalArrowLength={3.5}
                linkDirectionalArrowRelPos={1}
                linkColor={link => link.color || '#333'}
                
                // 파티클 효과 (자금 흐름 강조)
                linkDirectionalParticles={2}
                linkDirectionalParticleWidth={2}
                linkDirectionalParticleSpeed={0.005}

                onNodeClick={handleNodeClick}
                
                nodeCanvasObject={(node, ctx, globalScale) => {
                    const fontSize = 12/globalScale
                    ctx.font = `${fontSize}px monospace`
                    
                    if (node.group === 'target' || node.group === 'wallet') {
                        // 지갑 노드 (보라/파랑)
                        ctx.fillStyle = node.group === 'target' ? '#00b8ff' : '#bd00ff'
                        ctx.beginPath(); ctx.arc(node.x, node.y, 6, 0, 2*Math.PI); ctx.fill();
                        ctx.fillStyle='#fff'; 
                        // ID 살짝 보여주기
                        ctx.fillText(node.label || node.id.slice(0,4), node.x - 10, node.y - 10)
                    } else {
                        // TX 노드 (작은 점)
                        ctx.fillStyle = '#444'; 
                        ctx.beginPath(); ctx.arc(node.x, node.y, 3, 0, 2*Math.PI); ctx.fill();
                    }
                }}
            />
            {!selectedWallet && <div className="overlay-msg">SELECT TARGET TO TRACE FUNDS</div>}
        </div>

        <div className="detail-section">
            <div className="section-title" style={{background:'#111'}}>
                CONFIRMED FUND TRANSFERS (SENDER → RECEIVER)
            </div>
            <div className="table-scroll">
            <table className="digital-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Sender (Owner)</th>
                        <th>Amount / Token</th>
                        <th>Receiver (Owner)</th>
                        <th>TX Link</th>
                    </tr>
                </thead>
                <tbody>
                    {accumulatedFlows.map((flow, idx) => (
                        <tr key={idx}>
                            <td>
                                {flow.time ? formatDistanceToNow(new Date(flow.time * 1000)) : '-'}
                            </td>
                            <td>
                                {/* ⚠️ 수정: flow.from이 없을 경우 'Unknown' 처리 */}
                                <span className="addr-tag" title={flow.from || 'Unknown'}>
                                    {(flow.from || 'Unknown').slice(0, 6)}...
                                </span>
                            </td>
                            <td style={{ color: 'var(--neon-green)', fontWeight: 'bold' }}>
                                {flow.amount} →
                            </td>
                            <td>
                                {/* ⚠️ 수정: flow.to가 없을 경우 안전 처리 */}
                                <div className="full-addr-box" onClick={() => flow.to && copyToClipboard(flow.to)}>
                                    {(flow.to || 'Unknown').slice(0, 6)}...
                                    <span className="copy-hint">📋</span>
                                </div>
                            </td>
                            <td>
                                <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" className="tx-link">
                                    View
                                </a>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        </div>
      </div>
    </div>
  )
}

export default App