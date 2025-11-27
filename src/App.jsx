import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import axios from 'axios'
import { formatDistanceToNow } from 'date-fns'
import ForceGraph2D from 'react-force-graph-2d'
import './App.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY
const QUICKNODE_RPC = import.meta.env.VITE_QUICKNODE_RPC

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const SECRET_CODE = "49498989"

function App() {
  // State
  const [wallets, setWallets] = useState([])
  const [globalTxs, setGlobalTxs] = useState([]) // 오른쪽 패널용 (전체)
  const [selectedWallet, setSelectedWallet] = useState(null) // 현재 선택된 지갑
  const [localTxs, setLocalTxs] = useState([]) // 중앙 하단 패널용 (선택된 지갑 상세)
  
  const [newAddress, setNewAddress] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  // Graph State
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 })
  const mapRef = useRef(null)
  const fgRef = useRef()

  // --- 1. Init & Resize ---
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

  // --- 2. Global Polling (Right Sidebar) ---
  useEffect(() => {
    if (wallets.length > 0) {
      fetchGlobalTransactions()
      const interval = setInterval(fetchGlobalTransactions, 60000)
      return () => clearInterval(interval)
    }
  }, [wallets])

  // --- 3. Handlers ---
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

  // 전체 트랜잭션 조회 (가볍게 Signature만)
  const fetchGlobalTransactions = async () => {
    setLoading(true)
    let all = []
    try {
      const promises = wallets.map(async (w) => {
        const res = await axios.post(QUICKNODE_RPC, {
          jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
          params: [w.address, { limit: 5 }]
        })
        return (res.data.result || []).map(tx => ({ ...tx, wallet_label: w.label }))
      })
      const results = await Promise.all(promises)
      all = results.flat().sort((a, b) => b.blockTime - a.blockTime).slice(0, 20)
      setGlobalTxs(all)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  // ★ 특정 지갑 클릭 시: 심층 분석 (Deep Analyze)
  const handleWalletClick = async (wallet) => {
    setSelectedWallet(wallet)
    setDetailLoading(true)
    setLocalTxs([]) // 초기화
    
    // 그래프 초기화 (Center Node: Selected Wallet)
    const nodes = [{ id: wallet.address, group: 'root', label: wallet.label, val: 30 }]
    const links = []
    const nodeSet = new Set([wallet.address])

    try {
      // 1. 최근 TX 5개 조회
      const sigRes = await axios.post(QUICKNODE_RPC, {
        jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
        params: [wallet.address, { limit: 5 }]
      })
      const sigs = sigRes.data.result || []

      // 2. 각 TX의 상세 정보 조회 (Recipient 찾기 위해 getTransaction 호출)
      // 주의: API 호출량 증가함
      const detailPromises = sigs.map(async (tx) => {
        const txRes = await axios.post(QUICKNODE_RPC, {
            jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [tx.signature, { maxSupportedTransactionVersion: 0 }]
        })
        const txData = txRes.data.result
        
        // 간단한 수신자 추정 로직 (Solana에서 2번째 AccountKey가 보통 수신자)
        // 실제로는 더 복잡하지만 데모용으로 간단히 처리
        let recipient = "Unknown"
        if (txData && txData.transaction && txData.transaction.message) {
            const keys = txData.transaction.message.accountKeys
            // keys가 객체배열인 경우(version 0)와 문자열배열인 경우(legacy) 처리
            const destKey = typeof keys[1] === 'string' ? keys[1] : (keys[1]?.pubkey || "System")
            if (destKey && destKey !== wallet.address) recipient = destKey
        }

        return { ...tx, recipient, status: tx.err ? 'Fail' : 'Success' }
      })

      const detailedTxs = await Promise.all(detailPromises)
      setLocalTxs(detailedTxs)

      // 3. 그래프 데이터 구성 (Wallet -> Tx -> Recipient)
      detailedTxs.forEach(tx => {
        // TX Node
        if (!nodeSet.has(tx.signature)) {
            nodes.push({ id: tx.signature, group: 'tx', val: 10 })
            nodeSet.add(tx.signature)
            links.push({ source: wallet.address, target: tx.signature })
        }

        // Recipient Node (수신자)
        if (tx.recipient && tx.recipient !== "Unknown") {
            if (!nodeSet.has(tx.recipient)) {
                nodes.push({ id: tx.recipient, group: 'recipient', val: 15, label: 'Receiver' })
                nodeSet.add(tx.recipient)
            }
            // 링크 연결 (TX -> Recipient)
            links.push({ source: tx.signature, target: tx.recipient })
        }
      })

      setGraphData({ nodes, links })
      
      // 그래프 줌 리셋
      if(fgRef.current) fgRef.current.d3Force('charge').strength(-200)

    } catch (e) {
      console.error("Deep Scan Error:", e)
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="app-container">
      {/* 1. LEFT SIDEBAR */}
      <aside className="sidebar">
        <div className="brand">⚡ HAWK EYE</div>
        <div className="add-box">
          <input className="input-dark" placeholder="Addr" value={newAddress} onChange={e=>setNewAddress(e.target.value)} />
          <input className="input-dark" placeholder="Name" value={newLabel} onChange={e=>setNewLabel(e.target.value)} />
          <button className="btn-neon" onClick={addWallet}>ADD TARGET</button>
        </div>
        <div className="list-header">CLICK TO ANALYZE ({wallets.length})</div>
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

      {/* 2. CENTER PANEL (Split View) */}
      <div className="center-panel">
        
        {/* Top: Graph Map */}
        <div className="map-section" ref={mapRef}>
            <div className="section-title">
                <span>FLOW GRAPH: {selectedWallet ? selectedWallet.label : "SELECT A TARGET"}</span>
                {detailLoading && <span style={{color:'var(--neon-blue)'}}>ANALYZING DEEP DATA...</span>}
            </div>
            <ForceGraph2D
                ref={fgRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                backgroundColor="#000"
                nodeLabel="id"
                nodeColor={node => {
                    if(node.group === 'root') return '#00b8ff' // Blue (Target)
                    if(node.group === 'recipient') return '#bd00ff' // Purple (Recipient)
                    return '#00ff9d' // Green (Tx)
                }}
                nodeCanvasObject={(node, ctx, globalScale) => {
                    const fontSize = 12/globalScale
                    ctx.font = `${fontSize}px monospace`
                    
                    if (node.group === 'root') {
                        ctx.fillStyle = '#00b8ff'; ctx.fillRect(node.x-6, node.y-6, 12, 12)
                        ctx.fillStyle='#fff'; ctx.fillText(node.label, node.x, node.y-10)
                    } else if (node.group === 'recipient') {
                        ctx.fillStyle = '#bd00ff'; ctx.beginPath(); ctx.arc(node.x, node.y, 5, 0, 2*Math.PI); ctx.fill();
                        ctx.fillStyle='#bd00ff'; ctx.fillText(node.id.slice(0,4), node.x, node.y-8)
                    } else {
                        ctx.fillStyle = '#00ff9d'; ctx.beginPath(); ctx.arc(node.x, node.y, 3, 0, 2*Math.PI); ctx.fill();
                    }
                }}
                linkColor={() => '#333'}
                linkDirectionalParticles={2}
                linkDirectionalParticleSpeed={0.005}
            />
            {!selectedWallet && <div style={{position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', color:'#444'}}>SELECT WALLET FROM LEFT</div>}
        </div>

        {/* Bottom: Detail List */}
        <div className="detail-section">
            <div className="section-title" style={{background:'#111'}}>
                INTERCEPTED TRANSACTIONS & RECIPIENTS
            </div>
            <div className="table-scroll">
                <table className="digital-table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>TX Signature</th>
                            <th>Recipient (Est.)</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {localTxs.map(tx => (
                            <tr key={tx.signature}>
                                <td>{tx.blockTime ? formatDistanceToNow(new Date(tx.blockTime*1000)) : '-'}</td>
                                <td>
                                    <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" className="addr-tag" style={{textDecoration:'none'}}>
                                        {tx.signature.slice(0, 15)}...
                                    </a>
                                </td>
                                <td>
                                    {tx.recipient !== 'Unknown' ? (
                                        <span className="addr-tag recipient-tag">{tx.recipient.slice(0, 15)}...</span>
                                    ) : (
                                        <span style={{color:'#444'}}>-</span>
                                    )}
                                </td>
                                <td style={{color: tx.status==='Fail'?'red':'var(--neon-green)'}}>{tx.status}</td>
                            </tr>
                        ))}
                        {localTxs.length === 0 && selectedWallet && 
                            <tr><td colSpan="4" style={{textAlign:'center', padding:'20px'}}>No recent transactions or Loading...</td></tr>
                        }
                    </tbody>
                </table>
            </div>
        </div>
      </div>

      {/* 3. RIGHT SIDEBAR (Global Feed) */}
      <aside className="feed-sidebar">
        <div className="section-title">GLOBAL FEED (ALL TARGETS)</div>
        <div className="feed-list">
            {globalTxs.map(tx => (
                <div key={tx.signature} className="feed-item">
                    <div className="feed-row">
                        <span className="feed-time">{tx.blockTime ? formatDistanceToNow(new Date(tx.blockTime*1000)) : 'now'}</span>
                        <span className={`feed-status ${tx.err?'fail':'success'}`}>{tx.err?'FAIL':'OK'}</span>
                    </div>
                    <div className="feed-row">
                        <span className="feed-target">{tx.wallet_label}</span>
                    </div>
                    <div className="feed-row">
                        <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" style={{color:'#444', textDecoration:'none'}}>
                            TX: {tx.signature.slice(0,12)}...
                        </a>
                    </div>
                </div>
            ))}
            {loading && <div className="loading-overlay">Scanning...</div>}
        </div>
      </aside>
    </div>
  )
}

export default App