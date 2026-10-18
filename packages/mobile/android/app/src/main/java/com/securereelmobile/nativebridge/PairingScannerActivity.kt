// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.view.Gravity
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.journeyapps.barcodescanner.Size

/** Local camera preview only. Pairing and certificate confirmation remain in the bridge UI. */
class PairingScannerActivity: ComponentActivity() {
  private var preview: DecoratedBarcodeView?=null
  private var resumed=false
  private var completed=false
  private var torch=false
  private fun dp(value:Int)=(value*resources.displayMetrics.density).toInt()
  private fun cancel(code:String="SCAN_CANCELLED",message:String="已取消扫码") {
    if(completed)return
    completed=true
    preview?.pause()
    setResult(Activity.RESULT_CANCELED,Intent().putExtra("errorCode",code).putExtra("error",message))
    finish()
  }
  override fun onCreate(state:Bundle?) {
    super.onCreate(state)
    requestedOrientation=if(resources.configuration.smallestScreenWidthDp>=600)ActivityInfo.SCREEN_ORIENTATION_LOCKED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    onBackPressedDispatcher.addCallback(this,object:OnBackPressedCallback(true){override fun handleOnBackPressed(){cancel()}})
    if(!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {cancel("CAMERA_UNAVAILABLE","相机不可用，请使用手动配对");return}
    if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)showScanner()
    else requestPermissions(arrayOf(Manifest.permission.CAMERA),4804)
  }
  private fun showScanner() {
    if(preview!=null||completed)return
    val root=FrameLayout(this).apply {setBackgroundColor(Color.rgb(18,24,33))}
    fun surface(radius:Int,color:Int):RippleDrawable {
      val shape=GradientDrawable().apply {cornerRadius=dp(radius).toFloat();setColor(color)}
      return RippleDrawable(ColorStateList.valueOf(0x337ECFFF),shape,null)
    }
    val frameSide=dp(minOf(260,maxOf(100,resources.configuration.screenHeightDp-280)))
    root.setOnApplyWindowInsetsListener {view,insets->val bars=insets.getInsets(WindowInsets.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);insets}
    val header=LinearLayout(this).apply {orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;setPadding(dp(16),dp(12),dp(16),dp(12))}
    header.addView(Button(this).apply {text="‹";textSize=28f;contentDescription="返回";setTextColor(Color.WHITE);background=surface(24,0xCC25303E.toInt());minHeight=dp(48);minimumWidth=0;minWidth=0;setPadding(0,0,0,0);setOnClickListener {cancel()}},LinearLayout.LayoutParams(dp(48),dp(48)))
    header.addView(TextView(this).apply {text="连接电脑";textSize=22f;setTextColor(Color.WHITE);setPadding(dp(12),dp(12),0,0)},LinearLayout.LayoutParams(0,LinearLayout.LayoutParams.WRAP_CONTENT,1f))

    val instruction=TextView(this).apply {text="将电脑上的配对二维码放入取景框\n相机仅用于配对，不上传素材";textSize=15f;setTextColor(Color.LTGRAY);setPadding(dp(20),0,dp(20),dp(16))}

    val frame=FrameLayout(this)
    val scanner=DecoratedBarcodeView(this).apply {
      setDecoderFactory(DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE)))
      viewFinder.visibility=View.GONE
      viewFinder.setLaserVisibility(false)
      statusView.visibility=View.GONE
      barcodeView.framingRectSize=Size(frameSide,frameSide)
    }
    preview=scanner
    scanner.barcodeView.addStateListener(object:CameraPreview.StateListener {
      override fun previewSized(){}
      override fun previewStarted(){}
      override fun previewStopped(){}
      override fun cameraClosed(){}
      override fun cameraError(error:Exception){cancel("CAMERA_UNAVAILABLE","相机暂不可用，请返回后使用手动配对")}
    })
    frame.addView(scanner,FrameLayout.LayoutParams(-1,-1))
    frame.addView(object:View(this) {
      private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
      private val mask=Path()
      private val cutout=RectF()
      private val corners=Path()
      init {contentDescription="二维码取景框";importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO}
      override fun onDraw(canvas:Canvas) {
        super.onDraw(canvas)
        val side=minOf(frameSide.toFloat(),width*0.82f,height*0.82f)
        val rect=scanner.barcodeView.framingRect
        val left=rect?.left?.toFloat() ?: (width-side)/2f;val top=rect?.top?.toFloat() ?: (height-side)/2f
        val right=rect?.right?.toFloat() ?: left+side;val bottom=rect?.bottom?.toFloat() ?: top+side
        mask.reset();mask.fillType=Path.FillType.EVEN_ODD;mask.addRect(0f,0f,width.toFloat(),height.toFloat(),Path.Direction.CW);cutout.set(left,top,right,bottom);mask.addRoundRect(cutout,dp(18).toFloat(),dp(18).toFloat(),Path.Direction.CW)
        paint.style=Paint.Style.FILL;paint.color=0x88000000.toInt();canvas.drawPath(mask,paint)
        paint.style=Paint.Style.STROKE;paint.strokeWidth=dp(3).toFloat();paint.color=Color.rgb(126,207,255)
        paint.strokeCap=Paint.Cap.ROUND
        val corner=dp(30).toFloat();val radius=dp(18).toFloat()
        corners.reset()
        corners.moveTo(left,top+corner);corners.lineTo(left,top+radius);corners.quadTo(left,top,left+radius,top);corners.lineTo(left+corner,top)
        corners.moveTo(right-corner,top);corners.lineTo(right-radius,top);corners.quadTo(right,top,right,top+radius);corners.lineTo(right,top+corner)
        corners.moveTo(right,bottom-corner);corners.lineTo(right,bottom-radius);corners.quadTo(right,bottom,right-radius,bottom);corners.lineTo(right-corner,bottom)
        corners.moveTo(left+corner,bottom);corners.lineTo(left+radius,bottom);corners.quadTo(left,bottom,left,bottom-radius);corners.lineTo(left,bottom-corner)
        canvas.drawPath(corners,paint)
      }
    },FrameLayout.LayoutParams(-1,-1))
    root.addView(frame,FrameLayout.LayoutParams(-1,-1))
    root.addView(header,FrameLayout.LayoutParams(-1,-2,Gravity.TOP))
    val footer=LinearLayout(this).apply {orientation=LinearLayout.VERTICAL;setPadding(dp(20),dp(16),dp(20),dp(12));background=surface(24,0xEE192330.toInt())}
    val compact=resources.configuration.screenHeightDp<700 || resources.configuration.fontScale>=1.2f
    instruction.text=if(compact)"将电脑二维码放入取景框"else "将电脑二维码放入取景框\n识别后核对电脑身份，再确认连接"
    instruction.setPadding(0,0,0,dp(12))
    footer.addView(instruction)
    if(packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH))header.addView(Button(this).apply {text="⚡︎";contentDescription="开启补光";setTextColor(Color.rgb(126,207,255));background=surface(24,0xCC25303E.toInt());minHeight=dp(48);minimumWidth=0;minWidth=0;setPadding(0,0,0,0);setOnClickListener {torch=!torch;if(torch)scanner.setTorchOn()else scanner.setTorchOff();contentDescription=if(torch)"关闭补光"else"开启补光";isSelected=torch}},LinearLayout.LayoutParams(dp(48),dp(48)))
    footer.addView(Button(this).apply {text="无法扫码？手动配对";textSize=14f;minHeight=dp(48);setTextColor(Color.rgb(126,207,255));background=surface(14,0xFF253549.toInt());setOnClickListener {cancel("SCAN_MANUAL","使用手动配对")}})
    if(!compact)footer.addView(TextView(this).apply {text="相机仅用于配对 · 不上传素材";textSize=12f;gravity=Gravity.CENTER;setTextColor(Color.rgb(151,169,189));setPadding(0,dp(12),0,0)})
    root.addView(footer,FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM).apply {setMargins(dp(20),0,dp(20),dp(20))})
    setContentView(root)
    scanner.decodeContinuous(object:BarcodeCallback {
      override fun barcodeResult(result:BarcodeResult) {
        if(completed)return
        val code=result.text
        if(code.isNullOrBlank()||code.length>4096){instruction.text="二维码内容不适用，请扫描电脑上的配对二维码";return}
        completed=true;scanner.pause()
        setResult(Activity.RESULT_OK,Intent().putExtra("code",code));finish()
      }
    })
    if(resumed)scanner.resume()
  }
  override fun onResume(){super.onResume();resumed=true;if(!completed)preview?.resume()}
  override fun onPause(){resumed=false;preview?.pause();super.onPause()}
  override fun onDestroy(){preview?.pause();preview=null;super.onDestroy()}
  override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray){
    super.onRequestPermissionsResult(code,permissions,results)
    if(code==4804){if(results.firstOrNull()==PackageManager.PERMISSION_GRANTED)showScanner()else cancel("CAMERA_DENIED","相机权限未允许，可以使用手动配对")}
  }
}
