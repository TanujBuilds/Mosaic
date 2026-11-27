import AppKit

// The owner-approved SVG is the single source for the Dock and app brand mark.
@main struct IconBuilder {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain:"MosaicIcon",code:1,userInfo:[NSLocalizedDescriptionKey:"Expected iconset folder and SVG source"])
        }
        let folder=URL(fileURLWithPath:CommandLine.arguments[1])
        let source=URL(fileURLWithPath:CommandLine.arguments[2])
        guard let image=NSImage(contentsOf:source) else {
            throw NSError(domain:"MosaicIcon",code:2,userInfo:[NSLocalizedDescriptionKey:"The approved SVG could not be loaded"])
        }
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        for size in [16,32,128,256,512] {
            for scale in [1,2] {
                let pixels=size*scale
                let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
                NSGraphicsContext.current?.imageInterpolation = .high
                let canvas=NSRect(x:0,y:0,width:pixels,height:pixels)
                NSColor.clear.setFill();canvas.fill(using:.copy)
                let inset=CGFloat(pixels)*32/1024
                image.draw(in:canvas.insetBy(dx:inset,dy:inset),from:.zero,operation:.sourceOver,fraction:1,respectFlipped:true,hints:nil)
                NSGraphicsContext.restoreGraphicsState()
                let name="icon_\(size)x\(size)\(scale==2 ? "@2x":"").png"
                try bitmap.representation(using:.png,properties:[:])!.write(to:folder.appendingPathComponent(name))
            }
        }
    }
}
