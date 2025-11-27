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
const SECRET_CODE = import.meta.env.VITE_SECRET_CODE

function App() {
  const [wallets, setWallets] = useState([])
  const [globalTxs, setGlobalTxs] = useState([])
  const [selectedWallet, setSelectedWallet] = useState(null)
  
  // 로컬 트랜잭션 (테이블용) - 그래프 확장시 계속 쌓임
  const [accumulatedTxs, setAccumulatedTxs] = useState([]) 
  
  const [newAddress, setNewAddress] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  // Graph State
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 })
  const mapRef = useRef(null)
  const fgRef = useRef()

  // 방문한 노드 추적 (중복 요청 방지용)
  const visitedNodes = useRef(new Set())

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

  useEffect(() => {
    if (wallets.length > 0) {
      fetchGlobalTransactions()
      const interval = setInterval(fetchGlobalTransactions, 60000)
      return () => clearInterval(interval)
    }
  }, [wallets])

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

  // ★ 공통 탐색 로직 (초기화 vs 확장에 재사용)
  // isExpand: true면 기존 그래프에 붙이기, false면 초기화
  const exploreAddress = async (address, label, isExpand = false) => {
    if (visitedNodes.current.has(address) && isExpand) {
        alert("Already explored this node!")
        return
    }
    
    setDetailLoading(true)
    
    // 그래프에 추가할 임시 저장소
    const newNodes = []
    const newLinks = []
    const existingNodeIds = new Set(isExpand ? graphData.nodes.map(n => n.id) : [])

    // 루트 노드가 없으면 추가
    if (!existingNodeIds.has(address)) {
        newNodes.push({ id: address, group: isExpand ? 'recipient' : 'root', label: label, val: 30 })
        existingNodeIds.add(address)
    }

    try {
      const sigRes = await axios.post(QUICKNODE_RPC, {
        jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
        params: [address, { limit: 5 }] // 확장 시 5개씩만
      })
      const sigs = sigRes.data.result || []

      const detailPromises = sigs.map(async (tx) => {
        const txRes = await axios.post(QUICKNODE_RPC, {
            jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [tx.signature, { maxSupportedTransactionVersion: 0 }]
        })
        const txData = txRes.data.result
        
        let recipient = "Unknown"
        if (txData && txData.transaction && txData.transaction.message) {
            const keys = txData.transaction.message.accountKeys
            const destKey = typeof keys[1] === 'string' ? keys[1] : (keys[1]?.pubkey || "System")
            
            // 수신자가 나(탐색주체)와 다르면 수신자로 간주
            if (destKey && destKey !== address && destKey !== "System") {
                recipient = destKey
            }
        }
        return { ...tx, recipient, status: tx.err ? 'Fail' : 'Success', sourceAddr: address }
      })

      const detailedTxs = await Promise.all(detailPromises)

      // 그래프 데이터 빌드
      detailedTxs.forEach(tx => {
        // TX Node
        if (!existingNodeIds.has(tx.signature)) {
            newNodes.push({ id: tx.signature, group: 'tx', val: 5 })
            existingNodeIds.add(tx.signature)
            newLinks.push({ source: address, target: tx.signature })
        }

        // Recipient Node
        if (tx.recipient && tx.recipient !== "Unknown") {
            if (!existingNodeIds.has(tx.recipient)) {
                newNodes.push({ id: tx.recipient, group: 'recipient', val: 20, label: 'Unknown' })
                existingNodeIds.add(tx.recipient)
            }
            newLinks.push({ source: tx.signature, target: tx.recipient })
        }
      })

      // 상태 업데이트
      if (isExpand) {
          setGraphData(prev => ({
              nodes: [...prev.nodes, ...newNodes],
              links: [...prev.links, ...newLinks]
          }))
          setAccumulatedTxs(prev => [...detailedTxs, ...prev]) // 테이블에도 추가
      } else {
          setGraphData({ nodes: newNodes, links: newLinks })
          setAccumulatedTxs(detailedTxs)
          visitedNodes.current.clear() // 초기화시 방문기록 삭제
      }
      
      visitedNodes.current.add(address)

    } catch (e) {
      console.error("Explore Error:", e)
    } finally {
      setDetailLoading(false)
    }
  }

  // 초기 클릭 (Reset & Start)
  const handleWalletClick = (wallet) => {
    setSelectedWallet(wallet)
    exploreAddress(wallet.address, wallet.label, false)
  }

  // 노드 클릭 (Expand)
  const handleNodeClick = (node) => {
    if (node.group === 'recipient') {
        // 수신자 노드를 클릭하면 거기서부터 다시 탐색 시작
        if (window.confirm(`Expand analysis for ${node.id}?`)) {
            exploreAddress(node.id, "Expanded", true)
        }
    } else if (node.group === 'root') {
        copyToClipboard(node.id)
    }
  }

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
    alert(`Copied: ${text}`)
  }

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="brand">⚡ ALVINTRACER</div>
        <div className="add-box">
          <input className="input-dark" placeholder="Addr" value={newAddress} onChange={e=>setNewAddress(e.target.value)} />
          <input className="input-dark" placeholder="Name" value={newLabel} onChange={e=>setNewLabel(e.target.value)} />
          <button className="btn-neon" onClick={addWallet}>ADD TARGET</button>
        </div>
        <div className="list-header">ROOT TARGETS ({wallets.length})</div>
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
                <span>INVESTIGATION GRAPH</span>
                {detailLoading && <span style={{color:'var(--neon-blue)'}}> EXPANDING NETWORK...</span>}
            </div>
            <ForceGraph2D
                ref={fgRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                backgroundColor="#000"
                nodeLabel={node => node.id} 
                // 노드 클릭 이벤트 연결
                onNodeClick={handleNodeClick}
                
                nodeColor={node => {
                    if(node.group === 'root') return '#00b8ff'
                    if(node.group === 'recipient') return '#bd00ff'
                    return '#00ff9d'
                }}
                nodeCanvasObject={(node, ctx, globalScale) => {
                    const fontSize = 12/globalScale
                    ctx.font = `${fontSize}px monospace`
                    
                    if (node.group === 'root') {
                        ctx.fillStyle = '#00b8ff'; ctx.fillRect(node.x-6, node.y-6, 12, 12)
                        ctx.fillStyle='#fff'; ctx.fillText(node.label || "Root", node.x, node.y-10)
                    } else if (node.group === 'recipient') {
                        // 클릭 유도를 위해 타겟 모양
                        ctx.fillStyle = '#bd00ff'; ctx.beginPath(); ctx.arc(node.x, node.y, 6, 0, 2*Math.PI); ctx.fill();
                        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5; ctx.stroke(); 
                        ctx.fillStyle='#bd00ff'; ctx.fillText("Click to Expand", node.x, node.y-10)
                    } else {
                        ctx.fillStyle = '#00ff9d'; ctx.beginPath(); ctx.arc(node.x, node.y, 3, 0, 2*Math.PI); ctx.fill();
                    }
                }}
                linkColor={() => '#444'}
                linkDirectionalParticles={2}
            />
            {!selectedWallet && <div style={{position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', color:'#444'}}>SELECT ROOT TARGET</div>}
        </div>

        <div className="detail-section">
            <div className="section-title" style={{background:'#111'}}>
                ACCUMULATED TRACE LOGS
            </div>
            <div className="table-scroll">
                <table className="digital-table">
                    <thead>
                        <tr>
                            <th>From (Source)</th>
                            <th>TX Hash</th>
                            <th>To (Recipient)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {accumulatedTxs.map(tx => (
                            <tr key={tx.signature + tx.sourceAddr}>
                                <td style={{color:'#888'}}>{tx.sourceAddr.slice(0,6)}...</td>
                                <td>
                                    <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" className="addr-tag">
                                        {tx.signature.slice(0, 8)}...
                                    </a>
                                </td>
                                <td>
                                    {tx.recipient !== 'Unknown' ? (
                                        <div className="full-addr-box" onClick={() => copyToClipboard(tx.recipient)}>
                                            {tx.recipient}
                                            <span className="copy-hint">Click to Copy</span>
                                        </div>
                                    ) : '-'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
      </div>

      <aside className="feed-sidebar">
        <div className="section-title">GLOBAL MONITORING</div>
        <div className="feed-list">
            {globalTxs.map(tx => (
                <div key={tx.signature} className="feed-item">
                    <div className="feed-row">
                        <span className="feed-time">{tx.blockTime ? formatDistanceToNow(new Date(tx.blockTime*1000)) : 'now'}</span>
                        <span className={`feed-status ${tx.err?'fail':'success'}`}>{tx.err?'FAIL':'OK'}</span>
                    </div>
                    <div className="feed-row"><span className="feed-target">{tx.wallet_label}</span></div>
                    <div className="feed-row">
                        <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" style={{color:'#666'}}>
                            {tx.signature.slice(0,12)}...
                        </a>
                    </div>
                </div>
            ))}
        </div>
      </aside>
    </div>
  )
}

export default App