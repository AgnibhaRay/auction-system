/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useState, useEffect, useRef, FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Car, User, Settings, Wifi, WifiOff, Crown, Clock, DollarSign, Sparkles, Volume2, Loader2, Image as ImageIcon, Search, AlertCircle } from 'lucide-react';

// --- CONFIG ---
const apiKey = "AIzaSyAVjM_AFdx_YjQqKCxjhlWgw4mgfhqrbN0"; // REPLACE THIS WITH YOUR GEMINI API KEY

// --- TYPES ---

type BadgeColor = 'green' | 'red' | 'blue' | 'purple';

interface BadgeProps {
  children: React.ReactNode;
  color: BadgeColor;
}

interface TimerRingProps {
  timeLeft: number;
}

interface AuctionState {
  itemName: string;
  amount: number;
  highBidder: string;
  timeLeft: number;
  running: boolean;
  status: string;
}

interface ServerMessage {
  type: 'update' | 'end' | 'bid' | 'start' | 'error';
  item_name?: string;
  amount: number;
  username: string;
  time_left: number;
  content?: string;
}

// --- UTILITY COMPONENTS ---

const Badge: React.FC<BadgeProps> = ({ children, color }) => {
  const colors: Record<BadgeColor, string> = {
    green: "bg-emerald-500/20 text-emerald-300 border-emerald-500/50",
    red: "bg-rose-500/20 text-rose-300 border-rose-500/50",
    blue: "bg-blue-500/20 text-blue-300 border-blue-500/50",
    purple: "bg-purple-500/20 text-purple-300 border-purple-500/50",
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1 ${colors[color] || colors.blue}`}>
      {children}
    </span>
  );
};

const TimerRing: React.FC<TimerRingProps> = ({ timeLeft }) => {
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(timeLeft / 60, 1) * circumference;

  return (
    <div className="relative flex items-center justify-center">
      {/* Background Circle */}
      <svg width="120" height="120" className="transform -rotate-90">
        <circle cx="60" cy="60" r={radius} stroke="#334155" strokeWidth="8" fill="transparent" />
        {/* Progress Circle */}
        <circle
          cx="60" cy="60" r={radius}
          stroke={timeLeft < 10 ? "#ef4444" : "#3b82f6"}
          strokeWidth="8"
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-linear"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className={`text-3xl font-bold tabular-nums ${timeLeft < 10 ? 'text-red-500 animate-pulse' : 'text-white'}`}>
          {timeLeft}
        </span>
        <span className="text-[10px] text-slate-400 font-medium tracking-widest">SEC</span>
      </div>
    </div>
  );
};

// --- MAIN PAGE COMPONENT ---

export default function AuctionPage() {
  const [connected, setConnected] = useState<boolean>(false);
  const [isAdminMode, setIsAdminMode] = useState<boolean>(false);
  const [username, setUsername] = useState<string>("");

  // AI State
  const [aiCommentary, setAiCommentary] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  
  // New AI Features State
  const [rivalPersona, setRivalPersona] = useState<string>("");
  const [isAnalyzingRival, setIsAnalyzingRival] = useState<boolean>(false);
  const [adminImageBase64, setAdminImageBase64] = useState<string | null>(null);
  const [adminImagePreview, setAdminImagePreview] = useState<string | null>(null);

  // Admin Form State
  const [adminItemName, setAdminItemName] = useState("");
  const [adminPrice, setAdminPrice] = useState("5000");
  const [adminFunFact, setAdminFunFact] = useState("");

  const [auctionState, setAuctionState] = useState<AuctionState>({
    itemName: "Waiting for Vehicle...",
    amount: 0,
    highBidder: "None",
    timeLeft: 0,
    running: false,
    status: "Connecting...",
  });

  const socketRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize random username on client mount
  useEffect(() => {
    setUsername("Guest-" + Math.floor(Math.random() * 1000));
    audioRef.current = new Audio();
  }, []);

  // WebSocket Connection Logic
  useEffect(() => {
    const wsUrl = "ws://localhost:8080/ws"; 
    
    let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setAuctionState((prev) => ({ ...prev, status: "Connected" }));
      };

      ws.onclose = () => {
        setConnected(false);
        setAuctionState((prev) => ({ ...prev, status: "Disconnected" }));
        setTimeout(connect, 3000);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          
          if (msg.type === "update") {
            setAuctionState((prev) => ({
              ...prev,
              itemName: msg.item_name || prev.itemName,
              amount: msg.amount,
              highBidder: msg.username,
              timeLeft: msg.time_left,
              running: msg.time_left > 0,
              status: msg.time_left > 0 ? "LIVE" : "ENDED",
            }));
            // Clear old rival data on new item
            if (msg.item_name && msg.item_name !== auctionState.itemName) {
               setRivalPersona("");
            }
          } else if (msg.type === "end") {
            setAuctionState((prev) => ({
              ...prev,
              running: false,
              timeLeft: 0,
              status: "SOLD",
              highBidder: msg.username,
              amount: msg.amount,
            }));
          }
        } catch (e) {
          console.error("Message parse error", e);
        }
      };
    };

    connect();

    return () => {
      if (ws) ws.close();
    };
  }, []);

  // --- GEMINI API INTEGRATIONS ---

  const generateAIHype = async (item: string) => {
    if (!item || item.includes("Waiting")) return;
    setIsGenerating(true);
    setRivalPersona(""); // Clear previous rival intel
    
    try {
      // 1. Text Generation
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Write a very short, 1-sentence, high-energy car auctioneer intro for a vehicle named "${item}". Mention horsepower or engine specs if implied. Use car emojis.` }] }]
        })
      });
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "Start your engines for this one!";
      setAiCommentary(text);

      // 2. Audio Generation (TTS)
      const ttsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Rolling onto the block now, we have a ${item}!` }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Fenrir" } } }
          }
        })
      });
      
      const ttsData = await ttsResponse.json();
      const audioContent = ttsData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      
      if (audioContent) {
        playPCM(audioContent);
      }
      
    } catch (e) {
      console.error("AI Error", e);
      setAiCommentary("✨ Analyzing vehicle specs...");
    } finally {
      setIsGenerating(false);
    }
  };

  const playPCM = (base64Data: string) => {
    try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const int16View = new Int16Array(bytes.buffer);
        const float32Buffer = audioCtx.createBuffer(1, int16View.length, 24000);
        const channelData = float32Buffer.getChannelData(0);
        for (let i = 0; i < int16View.length; i++) {
            channelData[i] = int16View[i] / 32768.0;
        }
        
        const source = audioCtx.createBufferSource();
        source.buffer = float32Buffer;
        source.connect(audioCtx.destination);
        source.start();
        setIsPlayingAudio(true);
        source.onended = () => setIsPlayingAudio(false);
    } catch (e) {
        console.error("Audio Playback Error", e);
    }
  };

  const estimateItemDetails = async () => {
    setIsGenerating(true);
    try {
      let promptText = "";
      const contentParts: any[] = [];

      if (adminImageBase64) {
        // Multimodal Request (Image + Text)
        promptText = `You are an expert car appraiser. Look at this image. Identify the car model. Provide a JSON object with: 
        1. "model_name": The identified car make and model.
        2. "price": a realistic starting auction price in USD (integer) for this specific condition. 
        3. "fun_fact": A fun observation about this specific car's visual features (rims, color, spoiler, etc).`;
        
        contentParts.push({ text: promptText });
        contentParts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: adminImageBase64
          }
        });
      } else if (adminItemName) {
        // Text Only Request
        promptText = `You are an expert car appraiser. For the vehicle "${adminItemName}", provide a JSON object with: 
        1. "model_name": "${adminItemName}",
        2. "price": a realistic starting auction price in USD (integer). 
        3. "fun_fact": a one sentence cool technical or historical fact about this car model.`;
        contentParts.push({ text: promptText });
      } else {
        return; // Nothing to analyze
      }

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: contentParts }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const data = await response.json();
      const result = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text);
      
      if (result) {
        setAdminItemName(result.model_name);
        setAdminPrice(result.price.toString());
        setAdminFunFact(result.fun_fact);
      }
    } catch (e) {
      console.error("Estimation Error", e);
    } finally {
      setIsGenerating(false);
    }
  };

  const analyzeRival = async () => {
     if (!auctionState.highBidder || auctionState.highBidder === "None") return;
     setIsAnalyzingRival(true);
     try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Create a funny, 1-sentence fictional psychological persona for a bidder named "${auctionState.highBidder}" who just bid ${auctionState.amount} on a ${auctionState.itemName}. Are they a collector, a reckless spender, or a drift enthusiast?` }] }]
          })
        });
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        setRivalPersona(text);
     } catch (e) {
        console.error("Rival Analysis Error", e);
     } finally {
        setIsAnalyzingRival(false);
     }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        // Remove data URL prefix for API
        const rawBase64 = base64String.split(',')[1];
        setAdminImageBase64(rawBase64);
        setAdminImagePreview(base64String);
      };
      reader.readAsDataURL(file);
    }
  };

  // Trigger AI hype when item changes
  useEffect(() => {
    if (auctionState.itemName && !auctionState.itemName.includes("Waiting")) {
      generateAIHype(auctionState.itemName);
    }
  }, [auctionState.itemName]);


  // --- ACTIONS ---

  const sendBid = (increment: number) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      const payload: Partial<ServerMessage> = {
        type: "bid",
        username: username,
        amount: auctionState.amount + increment
      };
      socketRef.current.send(JSON.stringify(payload));
    }
  };

  const startAuction = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      const payload: Partial<ServerMessage> = {
        type: "start",
        item_name: adminItemName,
        amount: parseInt(adminPrice)
      };
      socketRef.current.send(JSON.stringify(payload));
      setAdminFunFact("");
      setAdminImageBase64(null); // Reset image
      setAdminImagePreview(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#0f172a] text-slate-200 flex items-center justify-center p-4 relative overflow-hidden font-sans">
      
      {/* Background Blobs */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-blue-600/10 rounded-full blur-[100px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-purple-600/10 rounded-full blur-[100px]"></div>
      </div>

      {/* Main Glass Card */}
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-md bg-slate-900/60 backdrop-blur-xl border border-slate-700/50 rounded-3xl shadow-2xl overflow-hidden z-10"
      >
        
        {/* Header */}
        <div className="p-6 border-b border-slate-700/50 flex justify-between items-center bg-slate-950/30">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-500/20 rounded-lg">
              <Car className="w-5 h-5 text-blue-400" />
            </div>
            <h1 className="font-bold text-lg tracking-tight text-white">
              Hand2<span className="text-blue-400">Mart</span>
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Badge color={connected ? "green" : "red"}>
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {connected ? "LIVE" : "OFF"}
            </Badge>
            <button 
              onClick={() => setIsAdminMode(!isAdminMode)}
              className="p-2 hover:bg-slate-700/50 rounded-full transition-colors text-slate-400 hover:text-white"
            >
              {isAdminMode ? <User className="w-5 h-5" /> : <Settings className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Dynamic Content Area */}
        <div className="p-8 min-h-[400px] flex flex-col items-center">
          <AnimatePresence mode="wait">
            {!isAdminMode ? (
              <motion.div 
                key="bidder"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="w-full flex flex-col items-center text-center space-y-6"
              >
                {/* AI Commentary Section */}
                {aiCommentary && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }} 
                    animate={{ opacity: 1, y: 0 }}
                    className="w-full bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-lg p-3 text-xs text-indigo-200 flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-3 h-3 text-yellow-400 flex-shrink-0" />
                      <span className="italic">{aiCommentary}</span>
                    </div>
                    {isPlayingAudio && <Volume2 className="w-3 h-3 text-indigo-400 animate-pulse flex-shrink-0" />}
                  </motion.div>
                )}

                {/* Item Name */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-500 tracking-widest uppercase">Current Vehicle</span>
                  <h2 className="text-2xl font-bold text-white leading-tight max-w-[250px] mx-auto">
                    {auctionState.itemName}
                  </h2>
                </div>

                {/* Visualizer Row */}
                <div className="flex items-center justify-center gap-8 w-full">
                  <TimerRing timeLeft={auctionState.timeLeft} />
                  
                  <div className="flex flex-col items-start">
                    <span className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1">
                      <DollarSign className="w-3 h-3" /> Current Bid
                    </span>
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={auctionState.amount}
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: -20, opacity: 0 }}
                        className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400"
                      >
                        ${auctionState.amount}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>

                {/* High Bidder Card */}
                <div className={`w-full p-4 rounded-xl border border-slate-700/50 flex flex-col gap-3 transition-colors ${
                  auctionState.highBidder === username ? 'bg-blue-900/20 border-blue-500/30' : 'bg-slate-800/40'
                }`}>
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center font-bold text-sm text-slate-300">
                        {auctionState.highBidder.substring(0,2).toUpperCase()}
                        </div>
                        <div className="text-left">
                        <div className="text-[10px] text-slate-400 uppercase font-bold">Winning</div>
                        <div className="font-semibold text-sm text-slate-200">
                            {auctionState.highBidder === username ? "You" : auctionState.highBidder}
                        </div>
                        </div>
                    </div>
                    {auctionState.highBidder !== "None" && (
                        <Crown className={`w-5 h-5 ${auctionState.highBidder === username ? 'text-blue-400' : 'text-slate-600'}`} />
                    )}
                  </div>
                  
                  {/* Rival Intel Button */}
                  {auctionState.highBidder !== "None" && auctionState.highBidder !== username && (
                     <div className="w-full">
                         {!rivalPersona ? (
                             <button 
                                onClick={analyzeRival}
                                disabled={isAnalyzingRival}
                                className="w-full py-2 px-3 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-xs text-slate-300 flex items-center justify-center gap-2 transition"
                             >
                                <Search className="w-3 h-3" />
                                {isAnalyzingRival ? "Intercepting Signals..." : "Analyze Rival"}
                             </button>
                         ) : (
                             <div className="bg-slate-900/50 p-2 rounded text-[10px] text-slate-400 flex items-start gap-2">
                                <AlertCircle className="w-3 h-3 text-orange-400 flex-shrink-0 mt-0.5" />
                                <span>{rivalPersona}</span>
                             </div>
                         )}
                     </div>
                  )}
                </div>

                {/* Controls */}
                <div className="w-full space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    {[100, 500, 1000].map((amt) => (
                      <button
                        key={amt}
                        onClick={() => sendBid(amt)}
                        disabled={!auctionState.running}
                        className="py-3 px-2 rounded-xl bg-slate-800 hover:bg-blue-600 hover:text-white text-slate-300 font-bold text-sm transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-700 hover:border-blue-500"
                      >
                        +${amt}
                      </button>
                    ))}
                  </div>
                  <input 
                    type="text" 
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-slate-950/50 border border-slate-800 rounded-lg py-2 px-4 text-center text-sm text-slate-400 focus:outline-none focus:text-white focus:border-blue-500 transition-colors"
                  />
                </div>

              </motion.div>
            ) : (
              <motion.div 
                key="admin"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="w-full text-left space-y-6"
              >
                <div className="flex items-center gap-2 mb-6 justify-center text-purple-400">
                  <Settings className="w-6 h-6" />
                  <h2 className="font-bold text-xl">Admin Console</h2>
                </div>

                <form onSubmit={startAuction} className="space-y-4">
                  
                  {/* Image Upload Area */}
                  <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase ml-1">Vehicle Image (Optional)</label>
                      <div className="relative group">
                          <input 
                             type="file" 
                             accept="image/*"
                             onChange={handleImageUpload}
                             className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                          />
                          <div className={`w-full p-4 border-2 border-dashed rounded-xl flex flex-col items-center justify-center transition-colors ${adminImagePreview ? 'border-purple-500 bg-purple-900/10' : 'border-slate-700 bg-slate-800/50 group-hover:bg-slate-800'}`}>
                             {adminImagePreview ? (
                                 <img src={adminImagePreview} alt="Preview" className="h-20 w-auto rounded object-cover" />
                             ) : (
                                 <>
                                    <ImageIcon className="w-6 h-6 text-slate-400 mb-2" />
                                    <span className="text-xs text-slate-500">Click to upload photo</span>
                                 </>
                             )}
                          </div>
                      </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase ml-1">Vehicle Name</label>
                    <div className="flex gap-2">
                      <input 
                        name="itemName" 
                        value={adminItemName}
                        onChange={(e) => setAdminItemName(e.target.value)}
                        required 
                        className="w-full bg-slate-800/50 border border-slate-700 rounded-xl p-3 text-white focus:border-purple-500 outline-none transition-colors" 
                        placeholder="e.g. 2022 Ford Mustang GT" 
                      />
                      <button 
                        type="button"
                        onClick={estimateItemDetails}
                        disabled={isGenerating || (!adminItemName && !adminImageBase64)}
                        className="p-3 bg-purple-600/20 hover:bg-purple-600/40 text-purple-300 rounded-xl border border-purple-500/30 transition-colors disabled:opacity-50"
                        title={adminImageBase64 ? "Identify car from image" : "Estimate from name"}
                      >
                        {isGenerating ? <Loader2 className="w-5 h-5 animate-spin"/> : <Sparkles className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                  
                  {adminFunFact && (
                     <div className="text-[10px] text-purple-300 bg-purple-900/20 p-2 rounded-lg border border-purple-500/20">
                       <span className="font-bold">Gemini says:</span> {adminFunFact}
                     </div>
                  )}
                  
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase ml-1">Starting Price</label>
                    <div className="relative">
                      <span className="absolute left-4 top-3 text-slate-500">$</span>
                      <input 
                        name="startPrice" 
                        type="number" 
                        value={adminPrice}
                        onChange={(e) => setAdminPrice(e.target.value)}
                        required 
                        className="w-full bg-slate-800/50 border border-slate-700 rounded-xl p-3 pl-8 text-white focus:border-purple-500 outline-none transition-colors" 
                      />
                    </div>
                  </div>

                  <button className="w-full mt-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-bold py-4 rounded-xl shadow-lg shadow-purple-900/20 active:scale-95 transition-transform flex items-center justify-center gap-2">
                    <Clock className="w-5 h-5" />
                    START AUCTION
                  </button>
                </form>

                <div className="pt-6 border-t border-slate-800">
                  <div className="bg-slate-950 p-4 rounded-lg font-mono text-xs space-y-1 text-slate-400 border border-slate-800">
                    <div className="flex justify-between">
                      <span>Status:</span>
                      <span className={connected ? "text-green-400" : "text-red-400"}>{connected ? "ONLINE" : "OFFLINE"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Socket ID:</span>
                      <span>{socketRef.current ? "Active" : "Null"}</span>
                    </div>
                  </div>
                </div>

              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="bg-slate-950/50 p-3 border-t border-slate-800 text-center">
          <p className="text-[10px] text-slate-500 font-medium tracking-wider">
            {auctionState.running ? "🔴 LIVE AUCTION IN PROGRESS" : "WAITING FOR NEXT VEHICLE..."}
          </p>
        </div>

      </motion.div>
    </main>
  );
}