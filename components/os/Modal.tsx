
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
    isOpen: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
    keyboardAware?: boolean;
}

const Modal: React.FC<ModalProps> = ({ isOpen, title, onClose, children, footer, keyboardAware = false }) => {
    const [viewport, setViewport] = useState<React.CSSProperties>({});
    useEffect(() => {
        if (!isOpen || !keyboardAware) return;
        const vv = window.visualViewport;
        const update = () => setViewport({
            top: vv?.offsetTop ?? 0, left: vv?.offsetLeft ?? 0,
            width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight,
            bottom: 'auto', right: 'auto',
        });
        update();
        vv?.addEventListener('resize', update);
        vv?.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        return () => {
            vv?.removeEventListener('resize', update);
            vv?.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
        };
    }, [isOpen, keyboardAware]);
    if (!isOpen) return null;

    const content = (
        <div style={keyboardAware ? viewport : undefined} className={`fixed inset-0 z-[100] flex items-center justify-center animate-fade-in ${keyboardAware ? 'p-3' : 'p-6'}`}>
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div role="dialog" aria-label={title} aria-modal="true" className={`relative w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl border border-white/20 overflow-hidden animate-slide-up ${keyboardAware ? 'max-h-full min-h-0 flex flex-col' : ''}`}>
                <div className="px-6 pt-6 pb-2 shrink-0">
                    <h3 className="text-lg font-bold text-slate-800 text-center">{title}</h3>
                </div>
                <div className={`px-6 py-4 overflow-y-auto no-scrollbar ${keyboardAware ? 'min-h-0' : 'max-h-[60vh]'}`}>
                    {children}
                </div>
                {footer ? (
                    <div className="px-6 pb-6 flex gap-3 shrink-0">
                        {footer}
                    </div>
                ) : (
                    <div className="px-6 pb-6 shrink-0">
                        <button 
                            onClick={onClose}
                            className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            关闭
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
    // 脱离手机壳的 transform / overflow 容器，坐标与 visualViewport 保持一致。
    return keyboardAware ? createPortal(content, document.body) : content;
};

export default Modal;
