package au.topoglobe.app;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TopoNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Back closes the menu / panels / measuring first; the web app decides and asks to exit last.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge != null) bridge.triggerWindowJSEvent("topoback");
                else finish();
            }
        });
    }
}
