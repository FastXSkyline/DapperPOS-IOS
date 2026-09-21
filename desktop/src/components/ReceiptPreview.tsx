import { useState, useEffect } from 'react'
import type { ReceiptData } from '../../shared/types'
import './ReceiptPreview.css'

interface ReceiptPreviewProps {
    data: ReceiptData
    onClose: () => void
    onPrint: () => void
}

export function ReceiptPreview({ data, onClose, onPrint }: ReceiptPreviewProps) {
    const [htmlContent, setHtmlContent] = useState('')
    const [loading, setLoading] = useState(true)
    const [invoiceLoading, setInvoiceLoading] = useState(false)

    useEffect(() => {
        const generatePreview = async () => {
            try {
                // @ts-ignore - exposed via preload
                const html = await window.electron.receipt.preview(data)
                setHtmlContent(html)
            } catch (error) {
                console.error('Failed to generate receipt preview:', error)
            } finally {
                setLoading(false)
            }
        }

        generatePreview()
    }, [data])

    const handlePrintA4 = async () => {
        setInvoiceLoading(true)
        try {
            // @ts-ignore
            await window.electron.invoice.print(data)
        } catch (error: any) {
            console.error('Failed to print A4 invoice:', error)
            alert('Échec de l\'impression A4: ' + (error.message || error))
        } finally {
            setInvoiceLoading(false)
        }
    }

    return (
        <div className="receipt-overlay">
            <div className="receipt-modal">
                <div className="receipt-header">
                    <div className="success-banner">
                        <span className="success-icon">✅</span>
                        <h2>Transaction Successful</h2>
                    </div>
                    <button className="btn-close" onClick={onClose}>×</button>
                </div>

                <div className="receipt-content">
                    {loading ? (
                        <div className="loading">Generating preview...</div>
                    ) : (
                        <iframe
                            className="preview-frame"
                            srcDoc={htmlContent}
                            title="Receipt Preview"
                            sandbox="allow-same-origin"
                        />
                    )}
                </div>


                <div className="receipt-actions">
                    <button className="btn-print" onClick={onPrint}>🖨️ Imprimer Ticket</button>
                    <button className="btn-invoice" onClick={handlePrintA4} disabled={invoiceLoading}>
                        {invoiceLoading ? 'Impression...' : '📄 Imprimer Bon de Livraison (A4)'}
                    </button>
                    <button className="btn-done" onClick={onClose}>✓ Terminé</button>
                </div>
            </div>
        </div>
    )
}
