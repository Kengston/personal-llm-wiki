import Foundation
import PDFKit
import Vision
import CoreGraphics
import CoreText

// Кладёт невидимый текстовый слой поверх картиночного PDF.
// Исходная страница рисуется как есть — ни один пиксель не меняется.

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: textlayer <in.pdf> <out.pdf>\n".data(using: .utf8)!); exit(2) }
let src = URL(fileURLWithPath: args[1])
let dst = URL(fileURLWithPath: args[2])

guard let doc = PDFDocument(url: src) else { print("не открылся PDF"); exit(1) }

var mediaBox = doc.page(at: 0)!.bounds(for: .mediaBox)
guard let out = CGContext(dst as CFURL, mediaBox: &mediaBox, nil) else { print("не создался выходной PDF"); exit(1) }

var totalWords = 0

for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let bounds = page.bounds(for: .mediaBox)

    // 1. Рендерим страницу в растр 400 dpi — только для распознавания
    let scale: CGFloat = 400.0 / 72.0
    let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
    guard let bmp = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
    bmp.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    bmp.fill(CGRect(x: 0, y: 0, width: w, height: h))
    bmp.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: bmp)
    guard let img = bmp.makeImage() else { continue }

    // 2. Распознаём текст с координатами
    var found: [(String, CGRect)] = []
    var raw: [(VNRecognizedText, CGRect)] = []
    let req = VNRecognizeTextRequest { r, _ in
        guard let obs = r.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            guard let c = o.topCandidates(1).first else { continue }
            raw.append((c, o.boundingBox))
        }

        // Разрядка ломает распознавание двумя способами. Второй: заголовок
        // приходит несколькими отдельными наблюдениями («E», «XPE», «RIE», «NCE»).
        // Склеиваем такие обрывки, если они на одной строке и стоят вплотную —
        // проверка зазора не даёт слить заголовки соседних колонок.
        func isFragment(_ s: String) -> Bool {
            !s.isEmpty && s.count <= 6 && s.allSatisfy { $0.isUppercase && $0.isLetter }
        }
        var handled = Set<Int>()
        let idx = raw.indices.sorted { raw[$0].1.minX < raw[$1].1.minX }
        for i in idx where !handled.contains(i) {
            let (ci, bi) = raw[i]
            guard isFragment(ci.string) else { continue }
            var group = [i]
            var box = bi
            for j in idx where j != i && !handled.contains(j) {
                let (cj, bj) = raw[j]
                guard isFragment(cj.string) else { continue }
                let sameLine = abs(bj.midY - box.midY) < box.height * 0.5
                let gap = bj.minX - box.maxX
                guard sameLine, gap > -box.height * 0.3, gap < box.height * 1.2 else { continue }
                group.append(j)
                box = box.union(bj)
            }
            guard group.count >= 2 else { continue }
            let word = group.sorted { raw[$0].1.minX < raw[$1].1.minX }
                            .map { raw[$0].0.string }.joined()
            guard word.count <= 24 else { continue }
            group.forEach { handled.insert($0) }
            found.append((word + " ", box))
        }

        for (n, pair) in raw.enumerated() where !handled.contains(n) {
            let cand = pair.0
            let s = cand.string
            let tokens = s.split(separator: " ").map(String.init)
            guard !tokens.isEmpty else { continue }

            // Заголовки набраны в разрядку — Vision видит «E X P E R I E N C E».
            // Склеиваем такую строку в одно слово и кладём на бокс всей строки.
            let singles = tokens.filter { $0.count == 1 }.count
            if tokens.count >= 4, Double(singles) / Double(tokens.count) >= 0.75 {
                found.append((tokens.joined() + " ", pair.1))
                continue
            }

            // Остальное — по словам, бокс каждого отдельно: точнее ложится.
            // Хвостовой пробел не даёт извлекателю склеить соседей.
            var searchFrom = s.startIndex
            for word in tokens {
                guard let rng = s.range(of: word, range: searchFrom..<s.endIndex) else { continue }
                searchFrom = rng.upperBound
                let box = (try? cand.boundingBox(for: rng))?.boundingBox ?? pair.1
                found.append((word + " ", box))
            }
        }
    }
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["en-US"]
    req.minimumTextHeight = 0.005
    do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) }
    catch { print("OCR не отработал на стр. \(i + 1): \(error)") }

    // 3. Рисуем исходную страницу и поверх — невидимый текст
    var box = bounds
    out.beginPDFPage([kCGPDFContextMediaBox as String: NSValue(rect: box)] as CFDictionary)
    page.draw(with: .mediaBox, to: out)

    out.saveGState()
    out.setTextDrawingMode(.invisible)
    for (text, bb) in found where !text.isEmpty {
        let rect = CGRect(x: bb.minX * box.width, y: bb.minY * box.height,
                          width: bb.width * box.width, height: bb.height * box.height)
        guard rect.width > 0.4, rect.height > 0.4 else { continue }
        let fs = max(rect.height * 0.82, 1.0)
        let font = CTFontCreateWithName("Helvetica" as CFString, fs, nil)
        let attr = NSAttributedString(string: text, attributes: [.font: font])
        let line = CTLineCreateWithAttributedString(attr)
        let natural = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
        let sx = natural > 0 ? rect.width / natural : 1.0
        out.textMatrix = CGAffineTransform(a: sx, b: 0, c: 0, d: 1, tx: rect.minX, ty: rect.minY)
        CTLineDraw(line, out)
        totalWords += 1
    }
    out.restoreGState()
    out.endPDFPage()
    _ = box
}

out.closePDF()
print("страниц: \(doc.pageCount), уложено слов: \(totalWords)")
