package au.topoglobe.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Native helpers for Topo Globe.
 *
 *  - Region files: the system file picker (ACTION_OPEN_DOCUMENT, no storage
 *    permission) and a copy into the app's private storage, so a region stays
 *    available offline even if the original download is deleted.
 *  - Durable small files (waypoints, settings): written to a temp file,
 *    fsync'd, then atomically renamed, so they survive a crash or reboot.
 *  - GNSS: raw GPS_PROVIDER fixes and satellite counts.  No network location
 *    provider is used: the app has no INTERNET permission and works in
 *    airplane mode, where the first fix can take several minutes.
 */
@CapacitorPlugin(
    name = "TopoNative",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location")
    }
)
public class TopoNativePlugin extends Plugin {

    private static final Pattern SAFE_NAME = Pattern.compile("^[A-Za-z0-9_.-]{1,64}$");
    private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9_-]{1,40}$");

    private LocationManager locationManager;
    private LocationListener locationListener;
    private GnssStatus.Callback gnssCallback;

    @Override
    public void load() {
        // remove imports left over from an interrupted session
        File imp = new File(getContext().getFilesDir(), "import");
        File[] old = imp.listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    // ------------------------------------------------------------------ region files

    private File dir(String name) {
        File d = new File(getContext().getFilesDir(), name);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private boolean inside(File f, File parent) throws IOException {
        return f.getCanonicalPath().startsWith(parent.getCanonicalPath() + File.separator);
    }

    @PluginMethod
    public void pickRegionFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        final Uri uri = data.getData();
        new Thread(() -> {
            String name = "region.topo";
            long size = -1;
            try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int si = c.getColumnIndex(OpenableColumns.SIZE);
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
                }
            } catch (Exception ignored) {
            }
            File out = new File(dir("import"), "import-" + System.currentTimeMillis() + ".topo");
            long copied = 0;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 FileOutputStream fos = new FileOutputStream(out)) {
                if (in == null) throw new IOException("cannot open the selected file");
                byte[] buf = new byte[1 << 20];
                int n;
                while ((n = in.read(buf)) > 0) {
                    fos.write(buf, 0, n);
                    copied += n;
                }
                fos.flush();
                fos.getFD().sync();
            } catch (Exception e) {
                out.delete();
                call.reject("Could not read the selected file: " + e.getMessage());
                return;
            }
            JSObject r = new JSObject();
            r.put("cancelled", false);
            r.put("path", out.getAbsolutePath());
            r.put("name", name);
            r.put("size", size >= 0 ? size : copied);
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void finalizeRegion(PluginCall call) {
        String tmpPath = call.getString("tmpPath");
        String id = call.getString("id");
        if (tmpPath == null || id == null || !SAFE_ID.matcher(id).matches()) {
            call.reject("bad region id");
            return;
        }
        try {
            File tmp = new File(tmpPath);
            if (!inside(tmp, dir("import")) || !tmp.exists()) {
                call.reject("import file missing");
                return;
            }
            File dst = new File(dir("regions"), id + ".topo");
            if (dst.exists() && !dst.delete()) throw new IOException("cannot replace " + dst.getName());
            if (!tmp.renameTo(dst)) throw new IOException("cannot store region");
            JSObject r = new JSObject();
            r.put("path", dst.getAbsolutePath());
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        try {
            File f = new File(path == null ? "" : path);
            if (!inside(f, getContext().getFilesDir())) {
                call.reject("not an app file");
                return;
            }
            f.delete();
            call.resolve();
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void listRegions(PluginCall call) {
        JSArray arr = new JSArray();
        File[] files = dir("regions").listFiles();
        if (files != null) {
            for (File f : files) {
                if (!f.getName().endsWith(".topo")) continue;
                JSObject o = new JSObject();
                o.put("id", f.getName().substring(0, f.getName().length() - 5));
                o.put("path", f.getAbsolutePath());
                o.put("size", f.length());
                arr.put(o);
            }
        }
        JSObject r = new JSObject();
        r.put("files", arr);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ durable small files

    @PluginMethod
    public void writeText(PluginCall call) {
        String name = call.getString("name");
        String text = call.getString("text");
        if (name == null || text == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("bad name");
            return;
        }
        File d = dir("data");
        File tmp = new File(d, name + ".tmp");
        File dst = new File(d, name);
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(text.getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.getFD().sync(); // on disk before we switch to it
        } catch (IOException e) {
            call.reject("write failed: " + e.getMessage());
            return;
        }
        if (!tmp.renameTo(dst)) { // atomic replace on the same filesystem
            call.reject("rename failed");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void readText(PluginCall call) {
        String name = call.getString("name");
        JSObject r = new JSObject();
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("bad name");
            return;
        }
        File f = new File(dir("data"), name);
        if (!f.exists()) {
            r.put("text", JSObject.NULL);
            call.resolve(r);
            return;
        }
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n < 0) break;
                off += n;
            }
            r.put("text", new String(b, 0, off, StandardCharsets.UTF_8));
            call.resolve(r);
        } catch (IOException e) {
            call.reject("read failed: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ GPS

    @PluginMethod
    public void startGps(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "gpsPermissionCallback");
            return;
        }
        beginGps(call);
    }

    @PermissionCallback
    private void gpsPermissionCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) beginGps(call);
        else {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("reason", "Location permission was refused. Allow location for Topo Globe in Android settings to use GPS.");
            call.resolve(r);
        }
    }

    private void beginGps(PluginCall call) {
        JSObject r = new JSObject();
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            r.put("ok", false);
            r.put("reason", "Precise location is off. Allow \"precise\" location for Topo Globe to use GPS.");
            call.resolve(r);
            return;
        }
        locationManager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (locationManager == null) {
            r.put("ok", false);
            r.put("reason", "This phone has no location service.");
            call.resolve(r);
            return;
        }
        stopUpdates();
        locationListener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location loc) {
                notifyListeners("location", toJs(loc));
            }

            @Override
            public void onProviderDisabled(@NonNull String provider) {
                JSObject e = new JSObject();
                e.put("reason", "Location is turned off. Turn on Location in Android quick settings (airplane mode can stay on).");
                notifyListeners("gpsError", e);
            }

            @Override
            public void onProviderEnabled(@NonNull String provider) {
                JSObject e = new JSObject();
                e.put("reason", "");
                notifyListeners("gpsError", e);
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {
            }
        };
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, locationListener, Looper.getMainLooper());
            gnssCallback = new GnssStatus.Callback() {
                @Override
                public void onSatelliteStatusChanged(@NonNull GnssStatus status) {
                    int used = 0;
                    int n = status.getSatelliteCount();
                    for (int i = 0; i < n; i++) if (status.usedInFix(i)) used++;
                    JSObject o = new JSObject();
                    o.put("inView", n);
                    o.put("used", used);
                    notifyListeners("gnss", o);
                }
            };
            locationManager.registerGnssStatusCallback(gnssCallback, new Handler(Looper.getMainLooper()));
        } catch (SecurityException | IllegalArgumentException e) {
            r.put("ok", false);
            r.put("reason", "GPS unavailable: " + e.getMessage());
            call.resolve(r);
            return;
        }
        r.put("ok", locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER));
        if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            r.put("reason", "Location is turned off. Turn on Location in Android quick settings (airplane mode can stay on).");
        }
        call.resolve(r);
    }

    private JSObject toJs(Location loc) {
        JSObject o = new JSObject();
        o.put("lat", loc.getLatitude());
        o.put("lon", loc.getLongitude());
        o.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
        if (loc.hasAltitude()) o.put("altitude", loc.getAltitude());
        else o.put("altitude", JSObject.NULL);
        o.put("time", loc.getTime());
        o.put("provider", loc.getProvider() == null ? "gps" : loc.getProvider());
        return o;
    }

    private void stopUpdates() {
        if (locationManager == null) return;
        if (locationListener != null) locationManager.removeUpdates(locationListener);
        if (gnssCallback != null) locationManager.unregisterGnssStatusCallback(gnssCallback);
        locationListener = null;
        gnssCallback = null;
    }

    @PluginMethod
    public void stopGps(PluginCall call) {
        stopUpdates();
        call.resolve();
    }

    @PluginMethod
    public void getLastKnown(PluginCall call) {
        JSObject r = new JSObject();
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm != null && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                Location best = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                Location passive = lm.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER);
                if (best == null || (passive != null && passive.getTime() > best.getTime())) best = passive;
                if (best != null) {
                    r.put("lat", best.getLatitude());
                    r.put("lon", best.getLongitude());
                    r.put("accuracy", best.hasAccuracy() ? best.getAccuracy() : 9999);
                    r.put("time", best.getTime());
                }
            }
        } catch (SecurityException ignored) {
        }
        call.resolve(r);
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopUpdates();
        super.handleOnDestroy();
    }
}
