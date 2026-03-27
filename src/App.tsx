/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';
import Markdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Scale, 
  Upload, 
  FileText, 
  AlertTriangle, 
  CheckCircle2, 
  Download, 
  Loader2,
  Trash2,
  ChevronRight,
  History,
  Clock,
  X,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  Send,
  LogIn,
  LogOut,
  CreditCard,
  ShieldCheck,
  Star
} from 'lucide-react';
import { cn } from './lib/utils';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User,
  handleFirestoreError,
  OperationType
} from './firebase';
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  orderBy, 
  onSnapshot,
  serverTimestamp,
  addDoc,
  deleteDoc
} from 'firebase/firestore';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const GEMINI_MODEL = "gemini-1.5-flash";

interface Feedback {
  rating: 'positive' | 'negative' | null;
  comment: string;
}

interface HistoryItem {
  id: string;
  fileName: string;
  fileSize: number;
  date: any;
  analysis: string;
  fullText: string;
  feedback?: Feedback;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  isSubscribed: boolean;
  role?: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [currentAnalysisId, setCurrentAnalysisId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ rating: null, comment: '' });
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [showPricing, setShowPricing] = useState(false);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Sync user profile
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
          const newProfile: UserProfile = {
            uid: currentUser.uid,
            email: currentUser.email || '',
            displayName: currentUser.displayName || '',
            photoURL: currentUser.photoURL || '',
            isSubscribed: false,
            role: 'user'
          };
          await setDoc(userRef, { ...newProfile, createdAt: serverTimestamp() });
          setUserProfile(newProfile);
        } else {
          setUserProfile(userSnap.data() as UserProfile);
        }

        // Listen for analyses
        const analysesRef = collection(db, 'users', currentUser.uid, 'analyses');
        const q = query(analysesRef, orderBy('date', 'desc'));
        const unsubscribeAnalyses = onSnapshot(q, (snapshot) => {
          const items: HistoryItem[] = [];
          snapshot.forEach((doc) => {
            items.push({ id: doc.id, ...doc.data() } as HistoryItem);
          });
          setHistory(items);
        }, (err) => handleFirestoreError(err, OperationType.LIST, 'analyses'));

        return () => unsubscribeAnalyses();
      } else {
        setUserProfile(null);
        setHistory([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      setError("Erro ao fazer login: " + err.message);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setAnalysis(null);
      setFile(null);
    } catch (err: any) {
      setError("Erro ao sair: " + err.message);
    }
  };

  const handleSubscribe = async (priceId: string) => {
    if (!user) {
      handleLogin();
      return;
    }

    try {
      const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId,
          userId: user.uid,
          email: user.email
        }),
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || "Erro ao criar sessão de checkout");
      }
    } catch (err: any) {
      setError("Erro ao iniciar pagamento: " + err.message);
    }
  };

  const extractTextFromPdf = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(" ");
      fullText += pageText + "\n";
    }
    
    return fullText;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setAnalysis(null);
      setError(null);
    } else {
      setError("Por favor, selecione um arquivo PDF válido.");
    }
  };

  const generateAnalysis = async () => {
    if (!file) return;
    if (!user) {
      setError("Você precisa estar logado para realizar análises.");
      return;
    }

    setLoading(true);
    setError(null);
    setFeedback({ rating: null, comment: '' });
    setFeedbackSubmitted(false);

    try {
      const text = await extractTextFromPdf(file);
      
      if (!text.trim()) {
        throw new Error("Não foi possível extrair texto do PDF. O arquivo pode estar vazio ou ser apenas imagem.");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const prompt = `
        Aja como um Advogado Sênior Especialista em Gestão de Riscos. 
        Analise o contrato abaixo e gere um relatório rigoroso em Português:
        
        1. RESUMO: Objeto, partes e valores.
        2. ALERTAS DE RISCO: Liste 3 cláusulas perigosas ou desequilibradas.
        3. RESCISÃO: Quais as multas e prazos de saída? É justo para ambas as partes?
        4. VEREDITO: O contrato é seguro para assinar agora? Sim ou Não, e por quê?

        TEXTO DO CONTRATO:
        ${text.slice(0, 30000)}
      `;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ parts: [{ text: prompt }] }],
      });

      const resultText = response.text || "Não foi possível gerar a análise.";
      setAnalysis(resultText);
      setFullText(text);
      
      // Save to Firestore
      const analysesRef = collection(db, 'users', user.uid, 'analyses');
      const docRef = await addDoc(analysesRef, {
        userId: user.uid,
        fileName: file.name,
        fileSize: file.size,
        date: serverTimestamp(),
        analysis: resultText,
        fullText: text
      });
      setCurrentAnalysisId(docRef.id);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Ocorreu um erro durante a análise.");
    } finally {
      setLoading(false);
    }
  };

  const downloadReport = (content: string, fileName?: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analise_contrato_${fileName?.replace('.pdf', '') || 'relatorio'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const loadFromHistory = (item: HistoryItem) => {
    setAnalysis(item.analysis);
    setFullText(item.fullText);
    setCurrentAnalysisId(item.id);
    setFile(null);
    setShowHistory(false);
    setError(null);
    
    if (item.feedback) {
      setFeedback(item.feedback);
      setFeedbackSubmitted(true);
    } else {
      setFeedback({ rating: null, comment: '' });
      setFeedbackSubmitted(false);
    }
  };

  const submitFeedback = async () => {
    if (!user || !currentAnalysisId || !feedback.rating) return;

    try {
      const docRef = doc(db, 'users', user.uid, 'analyses', currentAnalysisId);
      await setDoc(docRef, { feedback }, { merge: true });
      setFeedbackSubmitted(true);
    } catch (err: any) {
      setError("Erro ao enviar feedback: " + err.message);
    }
  };

  const deleteHistoryItem = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    try {
      const docRef = doc(db, 'users', user.uid, 'analyses', id);
      await deleteDoc(docRef);
      if (currentAnalysisId === id) {
        setAnalysis(null);
        setFullText(null);
        setCurrentAnalysisId(null);
      }
    } catch (err: any) {
      setError("Erro ao excluir análise: " + err.message);
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans selection:bg-[#E6E6E6]">
      {/* Full Text Modal */}
      <AnimatePresence>
        {showFullText && fullText && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowFullText(false)} className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="fixed inset-6 md:inset-12 lg:inset-24 bg-white z-[70] shadow-2xl rounded-[32px] flex flex-col overflow-hidden">
              <div className="p-6 border-b border-[#E5E5E5] flex items-center justify-between bg-[#F9F9F9]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-[#F5F5F5] rounded-xl flex items-center justify-center text-[#1A1A1A]"><FileText size={20} /></div>
                  <div><h2 className="font-semibold">Texto Original</h2><p className="text-xs text-[#888]">Conteúdo extraído do PDF</p></div>
                </div>
                <button onClick={() => setShowFullText(false)} className="p-2 hover:bg-[#E5E5E5] rounded-full transition-colors"><X size={24} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-8 md:p-12 bg-[#FDFCFB]">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-[#444] max-w-3xl mx-auto">{fullText}</pre>
              </div>
              <div className="p-6 border-t border-[#E5E5E5] bg-white flex justify-end">
                <button onClick={() => setShowFullText(false)} className="px-8 py-3 bg-[#1A1A1A] text-white rounded-xl font-medium hover:bg-[#333]">Fechar</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Pricing Modal */}
      <AnimatePresence>
        {showPricing && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowPricing(false)} className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-white z-[70] rounded-[32px] p-8 shadow-2xl">
              <div className="text-center space-y-4 mb-8">
                <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center mx-auto"><Star size={32} fill="currentColor" /></div>
                <h2 className="text-3xl font-bold">Plano Pro</h2>
                <p className="text-[#666]">Análises ilimitadas, suporte prioritário e exportação avançada.</p>
              </div>
              <div className="bg-[#F9F9F9] rounded-2xl p-6 mb-8 border border-[#E5E5E5]">
                <div className="flex items-baseline gap-1 justify-center mb-6"><span className="text-4xl font-bold">R$ 49</span><span className="text-[#888]">/mês</span></div>
                <ul className="space-y-3 text-sm">
                  <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-green-600" /> Análises ilimitadas</li>
                  <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-green-600" /> Histórico completo na nuvem</li>
                  <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-green-600" /> Suporte jurídico especializado</li>
                </ul>
              </div>
              <button onClick={() => handleSubscribe('price_standard_monthly')} className="w-full bg-[#1A1A1A] text-white rounded-2xl py-4 font-bold hover:bg-[#333] transition-all flex items-center justify-center gap-2">
                <CreditCard size={20} /> Assinar Agora
              </button>
              <button onClick={() => setShowPricing(false)} className="w-full mt-4 text-sm text-[#888] hover:text-[#1A1A1A]">Talvez mais tarde</button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* History Sidebar */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowHistory(false)} className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 25 }} className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white z-50 shadow-2xl flex flex-col">
              <div className="p-6 border-b border-[#E5E5E5] flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold"><History size={20} /> Histórico</div>
                <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-[#F5F5F5] rounded-full"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {history.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-[#AAA]"><Clock size={40} className="mb-2" /><p>Sem histórico.</p></div>
                ) : (
                  history.map((item) => (
                    <div key={item.id} onClick={() => loadFromHistory(item)} className="group p-4 border border-[#E5E5E5] rounded-2xl hover:border-[#1A1A1A] hover:bg-[#F9F9F9] cursor-pointer transition-all relative">
                      <div className="flex items-center gap-2 text-sm font-medium mb-1 truncate pr-8"><FileText size={14} /> {item.fileName}</div>
                      <div className="text-[10px] text-[#888] uppercase tracking-wider">
                        {item.date?.toDate ? item.date.toDate().toLocaleDateString() : 'Recente'}
                      </div>
                      <button 
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-[#AAA] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="border-b border-[#E5E5E5] bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#1A1A1A] rounded-xl flex items-center justify-center text-white"><Scale size={24} /></div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Analista Jurídico IA</h1>
              <p className="text-xs text-[#666] uppercase tracking-widest font-medium">Risk Management System</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <>
                <button onClick={() => setShowHistory(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl hover:bg-[#F5F5F5] transition-colors font-medium text-sm">
                  <History size={18} /> Histórico
                </button>
                <div className="w-px h-6 bg-[#E5E5E5]" />
                <div className="flex items-center gap-3">
                  <img src={user.photoURL || ''} className="w-8 h-8 rounded-full border border-[#E5E5E5]" />
                  <button onClick={handleLogout} className="text-sm font-medium text-[#666] hover:text-red-500 transition-colors">Sair</button>
                </div>
              </>
            ) : (
              <button onClick={handleLogin} className="flex items-center gap-2 px-6 py-2.5 bg-[#1A1A1A] text-white rounded-xl font-medium text-sm hover:bg-[#333] transition-all">
                <LogIn size={18} /> Entrar com Google
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
          <div className="lg:col-span-5 space-y-8">
            <section className="space-y-4">
              <h2 className="text-3xl font-light tracking-tight leading-tight">Analise seus contratos em <span className="italic font-serif">segundos</span>.</h2>
              <p className="text-[#666] leading-relaxed">Identifique armadilhas jurídicas e riscos ocultos com nossa inteligência artificial especializada.</p>
            </section>

            {user && !userProfile?.isSubscribed && (
              <div className="bg-amber-50 border border-amber-100 rounded-3xl p-6 space-y-4">
                <div className="flex items-center gap-3 text-amber-800 font-semibold"><ShieldCheck size={20} /> Versão Gratuita</div>
                <p className="text-sm text-amber-700">Você está usando a versão limitada. Assine o plano Pro para análises ilimitadas.</p>
                <button onClick={() => setShowPricing(true)} className="w-full bg-amber-600 text-white rounded-xl py-3 text-sm font-bold hover:bg-amber-700 transition-all">Ver Planos</button>
              </div>
            )}

            <div className="space-y-6">
              {!file ? (
                <label className="group relative border-2 border-dashed border-[#E5E5E5] rounded-3xl p-12 flex flex-col items-center justify-center gap-4 cursor-pointer transition-all hover:border-[#1A1A1A] hover:bg-[#F9F9F9]">
                  <input type="file" className="hidden" accept="application/pdf" onChange={handleFileUpload} />
                  <div className="w-16 h-16 rounded-full bg-[#F5F5F5] flex items-center justify-center group-hover:scale-110 transition-transform"><Upload className="text-[#666] group-hover:text-[#1A1A1A]" size={28} /></div>
                  <div className="text-center"><p className="font-medium">Arraste seu PDF aqui</p><p className="text-sm text-[#888]">ou clique para selecionar</p></div>
                </label>
              ) : (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-white border border-[#E5E5E5] rounded-3xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-[#F5F5F5] rounded-2xl flex items-center justify-center text-[#1A1A1A]"><FileText size={24} /></div>
                      <div><p className="font-medium truncate max-w-[200px]">{file.name}</p><p className="text-xs text-[#888]">{(file.size / 1024 / 1024).toFixed(2)} MB</p></div>
                    </div>
                    <button onClick={() => { setFile(null); setAnalysis(null); }} className="p-2 text-[#888] hover:text-red-500"><Trash2 size={20} /></button>
                  </div>
                  {!analysis && (
                    <button onClick={generateAnalysis} disabled={loading} className="w-full bg-[#1A1A1A] text-white rounded-2xl py-4 font-medium flex items-center justify-center gap-2 hover:bg-[#333] disabled:opacity-50">
                      {loading ? <><Loader2 className="animate-spin" size={20} /> Processando...</> : <>Gerar Análise Profissional <ChevronRight size={20} /></>}
                    </button>
                  )}
                </motion.div>
              )}
              {error && <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-2xl flex items-start gap-3"><AlertTriangle size={20} className="shrink-0 mt-0.5" /><p className="text-sm">{error}</p></div>}
            </div>
          </div>

          <div className="lg:col-span-7">
            <AnimatePresence mode="wait">
              {loading ? (
                <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full min-h-[400px] flex flex-col items-center justify-center text-center space-y-6">
                  <div className="relative"><div className="w-24 h-24 border-4 border-[#F5F5F5] rounded-full"></div><div className="absolute top-0 left-0 w-24 h-24 border-4 border-t-[#1A1A1A] rounded-full animate-spin"></div></div>
                  <h3 className="text-lg font-medium">Analisando contrato...</h3>
                </motion.div>
              ) : analysis ? (
                <motion.div key="analysis" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="bg-white border border-[#E5E5E5] rounded-[32px] overflow-hidden shadow-sm">
                  <div className="p-8 border-b border-[#E5E5E5] flex items-center justify-between bg-[#F9F9F9]">
                    <div className="flex items-center gap-3"><div className="w-8 h-8 bg-[#1A1A1A] rounded-lg flex items-center justify-center text-white"><FileText size={18} /></div><h3 className="font-semibold">Relatório</h3></div>
                    <div className="flex items-center gap-4">
                      <button onClick={() => setShowFullText(true)} className="flex items-center gap-2 text-sm font-medium text-[#666] hover:text-[#1A1A1A]"><FileText size={18} /> Ver Texto</button>
                      <button onClick={() => downloadReport(analysis, file?.name)} className="flex items-center gap-2 text-sm font-medium hover:text-[#666] transition-colors"><Download size={18} /> Baixar</button>
                    </div>
                  </div>
                  <div className="p-8 prose prose-slate max-w-none"><div className="markdown-body"><Markdown>{analysis}</Markdown></div></div>
                  <div className="p-8 bg-[#FDFCFB] border-t border-[#E5E5E5]">
                    <div className="max-w-md mx-auto text-center">
                      {feedbackSubmitted ? <p className="text-green-600 font-medium">Obrigado pelo feedback!</p> : (
                        <div className="space-y-4">
                          <p className="text-sm font-medium">Esta análise foi útil?</p>
                          <div className="flex justify-center gap-4">
                            <button onClick={() => setFeedback(p=>({...p, rating:'positive'}))} className={cn("p-4 rounded-2xl border transition-all", feedback.rating==='positive' ? "bg-[#1A1A1A] text-white" : "bg-white text-[#888]")}><ThumbsUp size={24} /></button>
                            <button onClick={() => setFeedback(p=>({...p, rating:'negative'}))} className={cn("p-4 rounded-2xl border transition-all", feedback.rating==='negative' ? "bg-red-600 text-white" : "bg-white text-[#888]")}><ThumbsDown size={24} /></button>
                          </div>
                          {feedback.rating && <button onClick={submitFeedback} className="w-full bg-[#1A1A1A] text-white py-3 rounded-xl">Enviar Feedback</button>}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              ) : (
                <div className="h-full min-h-[400px] border-2 border-dashed border-[#F5F5F5] rounded-[32px] flex flex-col items-center justify-center text-[#AAA]"><Scale size={48} className="mb-4" /><p>Aguardando contrato...</p></div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      <style>{`
        .markdown-body h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem; }
        .markdown-body h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.75rem; border-bottom: 1px solid #EEE; padding-bottom: 0.5rem; }
        .markdown-body p { margin-bottom: 1rem; line-height: 1.6; color: #444; }
        .markdown-body ul { margin-bottom: 1rem; padding-left: 1.5rem; list-style-type: disc; }
      `}</style>
    </div>
  );
}
