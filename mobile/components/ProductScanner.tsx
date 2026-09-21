import { useState, useEffect } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, Alert } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { ProductService, type Product } from '../services/productService'

interface ProductScannerProps {
    onProductFound: (product: Product) => void
    onClose: () => void
}

const { width } = Dimensions.get('window')
const SCAN_AREA_SIZE = width * 0.7

export function ProductScanner({ onProductFound, onClose }: ProductScannerProps) {
    const [permission, requestPermission] = useCameraPermissions()
    const [scanned, setScanned] = useState(false)
    const [scanning, setScanning] = useState(true)

    useEffect(() => {
        if (!permission?.granted) {
            requestPermission()
        }
    }, [permission])

    const handleBarcodeScanned = async ({ type, data }: { type: string; data: string }) => {
        if (scanned) return
        setScanned(true)
        setScanning(false)

        try {
            const product = await ProductService.getByBarcode(data)
            if (product) {
                onProductFound(product)
            } else {
                Alert.alert(
                    'Product Not Found',
                    `No product found with barcode: ${data}`,
                    [
                        { text: 'Scan Again', onPress: () => { setScanned(false); setScanning(true) } },
                        { text: 'Cancel', onPress: onClose }
                    ]
                )
            }
        } catch (error) {
            Alert.alert('Error', 'Failed to lookup product')
            setScanned(false)
            setScanning(true)
        }
    }

    if (!permission) {
        return (
            <View style={styles.container}>
                <Text style={styles.message}>Requesting camera permission...</Text>
            </View>
        )
    }

    if (!permission.granted) {
        return (
            <View style={styles.container}>
                <Text style={styles.message}>Camera permission is required to scan barcodes</Text>
                <TouchableOpacity style={styles.button} onPress={requestPermission}>
                    <Text style={styles.buttonText}>Grant Permission</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
            </View>
        )
    }

    return (
        <View style={styles.container}>
            <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{
                    barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],
                }}
                onBarcodeScanned={scanning ? handleBarcodeScanned : undefined}
            >
                <View style={styles.overlay}>
                    <View style={styles.header}>
                        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                            <Text style={styles.closeText}>✕</Text>
                        </TouchableOpacity>
                        <Text style={styles.title}>Scan Barcode</Text>
                    </View>

                    <View style={styles.scanArea}>
                        <View style={[styles.corner, styles.topLeft]} />
                        <View style={[styles.corner, styles.topRight]} />
                        <View style={[styles.corner, styles.bottomLeft]} />
                        <View style={[styles.corner, styles.bottomRight]} />
                    </View>

                    <Text style={styles.hint}>
                        {scanning ? 'Position barcode within the frame' : 'Processing...'}
                    </Text>
                </View>
            </CameraView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
        justifyContent: 'center',
        alignItems: 'center',
    },
    camera: {
        flex: 1,
        width: '100%',
    },
    overlay: {
        flex: 1,
        backgroundColor: 'transparent',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 60,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        paddingHorizontal: 20,
    },
    closeButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeText: {
        color: 'white',
        fontSize: 20,
    },
    title: {
        flex: 1,
        textAlign: 'center',
        color: 'white',
        fontSize: 18,
        fontWeight: '600',
        marginRight: 44,
    },
    scanArea: {
        width: SCAN_AREA_SIZE,
        height: SCAN_AREA_SIZE * 0.6,
        position: 'relative',
    },
    corner: {
        position: 'absolute',
        width: 30,
        height: 30,
        borderColor: '#10B981',
        borderWidth: 3,
    },
    topLeft: {
        top: 0,
        left: 0,
        borderRightWidth: 0,
        borderBottomWidth: 0,
    },
    topRight: {
        top: 0,
        right: 0,
        borderLeftWidth: 0,
        borderBottomWidth: 0,
    },
    bottomLeft: {
        bottom: 0,
        left: 0,
        borderRightWidth: 0,
        borderTopWidth: 0,
    },
    bottomRight: {
        bottom: 0,
        right: 0,
        borderLeftWidth: 0,
        borderTopWidth: 0,
    },
    hint: {
        color: 'white',
        fontSize: 14,
        backgroundColor: 'rgba(0,0,0,0.5)',
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 20,
    },
    message: {
        color: 'white',
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 20,
    },
    button: {
        backgroundColor: '#9333EA',
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
        marginBottom: 12,
    },
    buttonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
    cancelButton: {
        paddingHorizontal: 24,
        paddingVertical: 12,
    },
    cancelText: {
        color: '#6B7280',
        fontSize: 16,
    },
})
