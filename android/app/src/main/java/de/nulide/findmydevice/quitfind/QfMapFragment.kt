package de.nulide.findmydevice.quitfind

import android.os.Bundle
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import de.nulide.findmydevice.R
import de.nulide.findmydevice.ui.TaggedFragment
import de.nulide.findmydevice.ui.theme.AppTheme
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline
import java.io.File

/** QuitFind: all devices of the linked owner account on one OpenStreetMap map. */
class QfMapFragment : TaggedFragment() {
    override fun getStaticTag(): String = "QfMapFragment"

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        ComposeView(requireContext()).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent { AppTheme { QfMapScreen() } }
        }
}

private fun typeIcon(type: String) = when (type) {
    "tag" -> "🏷"
    "laptop" -> "💻"
    "pc" -> "🖥"
    "tablet" -> "▭"
    else -> "📱"
}

@Composable
fun QfMapScreen(vm: QfMapViewModel = viewModel()) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    when (val s = ui) {
        QfUi.NotLinked -> LinkForm(null, vm::link)
        is QfUi.LinkFailed -> LinkForm(s.message, vm::link)
        is QfUi.Busy -> Column(Modifier.fillMaxSize(), Arrangement.Center, Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            if (s.linking) Text(stringResource(R.string.qf_linking), Modifier.padding(16.dp))
        }
        is QfUi.Ready -> DevicesView(s, vm::refresh, vm::unlink)
    }
}

@Composable
private fun LinkForm(error: String?, onLink: (String, String, String) -> Unit) {
    var server by rememberSaveable { mutableStateOf("") }
    var user by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.qf_link_title), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.qf_link_explain), style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.qf_server)) },
            placeholder = { Text("https://…") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.qf_username)) }, singleLine = true)
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.qf_password)) },
            singleLine = true, visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        if (error != null) Text(stringResource(R.string.qf_error, error), color = MaterialTheme.colorScheme.error)
        Button(onClick = { onLink(server, user, password) }, enabled = server.isNotBlank() && user.isNotBlank() && password.isNotEmpty()) {
            Text(stringResource(R.string.qf_link))
        }
    }
}

@Composable
private fun DevicesView(s: QfUi.Ready, onRefresh: () -> Unit, onUnlink: () -> Unit) {
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val names = remember(s.devices) { s.devices.associate { it.device.username to it.device.name } }
    Column(Modifier.fillMaxSize()) {
        DevicesMap(s.devices, selected, { selected = it }, Modifier.fillMaxWidth().weight(1f))
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (s.refreshing) CircularProgressIndicator(Modifier.padding(8.dp))
            TextButton(onClick = onRefresh) { Text(stringResource(R.string.qf_refresh)) }
            TextButton(onClick = onUnlink) { Text(stringResource(R.string.qf_unlink)) }
        }
        if (s.error != null) Text(stringResource(R.string.qf_error, s.error), Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error)
        if (s.devices.any { it.device.type == "tag" }) TagScanSwitch()
        if (s.devices.isEmpty()) Text(stringResource(R.string.qf_no_devices), Modifier.padding(16.dp))
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            items(s.devices, key = { it.device.itemId }) { dv ->
                DeviceRow(dv, names, dv.device.username == selected) {
                    selected = if (selected == dv.device.username) null else dv.device.username
                }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun TagScanSwitch() {
    val ctx = LocalContext.current
    var on by remember { mutableStateOf(QfTagScanWorker.isEnabled(ctx)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val ok = granted.values.all { it }
        QfTagScanWorker.setEnabled(ctx, ok)
        on = ok
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.qf_scan_tags), Modifier.weight(1f))
            Switch(on, { want ->
                if (want) ask.launch(QfTagScanWorker.permissions()) else { QfTagScanWorker.setEnabled(ctx, false); on = false }
            })
        }
        if (on) Text(stringResource(R.string.qf_scan_hint), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DeviceRow(dv: QfDeviceView, names: Map<String, String>, isSelected: Boolean, onClick: () -> Unit) {
    val last = dv.locations.lastOrNull()
    val parts = buildList {
        when {
            dv.error == QfMapViewModel.REFUSED -> add(stringResource(R.string.qf_key_rejected))
            dv.error != null -> add(stringResource(R.string.qf_error, dv.error))
            last == null -> add(stringResource(R.string.qf_never_seen))
            else -> {
                add(DateUtils.getRelativeTimeSpanString(last.date).toString())
                last.bat?.let { add(stringResource(R.string.qf_battery, it)) }
                last.provider?.let { add(it) }
                last.seenBy?.let { add(stringResource(R.string.qf_seen_by, names[it] ?: it)) }
            }
        }
    }
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp, 10.dp)) {
        Text("${typeIcon(dv.device.type)}  ${dv.device.name}",
            style = if (isSelected) MaterialTheme.typography.titleMedium.copy(color = MaterialTheme.colorScheme.primary) else MaterialTheme.typography.titleMedium)
        Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DevicesMap(devices: List<QfDeviceView>, selected: String?, onSelect: (String) -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val map = remember {
        Configuration.getInstance().apply {
            userAgentValue = context.packageName // OSM tile policy: identify the app
            osmdroidBasePath = File(context.cacheDir, "osmdroid")
            osmdroidTileCache = File(context.cacheDir, "osmdroid/tiles")
        }
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            controller.setZoom(4.0)
            controller.setCenter(GeoPoint(52.1, 5.3))
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) map.onResume()
            if (e == Lifecycle.Event.ON_PAUSE) map.onPause()
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); map.onDetach() }
    }
    // fit all devices once per new set of devices, and when a device is selected
    val fitKey = remember(devices, selected) { devices.map { it.device.username to it.locations.size } to selected }
    var fitted by remember { mutableStateOf<Any?>(null) }
    AndroidView({ map }, modifier) { m ->
        m.overlays.clear()
        val points = ArrayList<GeoPoint>()
        devices.forEach { dv ->
            val last = dv.locations.lastOrNull() ?: return@forEach
            val p = GeoPoint(last.lat, last.lon)
            points += p
            m.overlays += Marker(m).apply {
                position = p
                title = "${typeIcon(dv.device.type)} ${dv.device.name}"
                snippet = DateUtils.getRelativeTimeSpanString(last.date).toString()
                setOnMarkerClickListener { mk, _ -> onSelect(dv.device.username); mk.showInfoWindow(); true }
            }
        }
        val sel = devices.firstOrNull { it.device.username == selected }
        val track = sel?.locations?.filter { it.date > System.currentTimeMillis() - DateUtils.DAY_IN_MILLIS }
            ?.map { GeoPoint(it.lat, it.lon) }.orEmpty()
        if (track.size > 1) m.overlays += Polyline(m).apply { setPoints(track) }
        if (fitted != fitKey) {
            fitted = fitKey
            val focus = if (sel != null) (track.ifEmpty { listOfNotNull(sel.locations.lastOrNull()?.let { GeoPoint(it.lat, it.lon) }) }) else points
            m.post {
                when {
                    focus.size == 1 -> { m.controller.setZoom(16.0); m.controller.setCenter(focus[0]) }
                    focus.size > 1 -> m.zoomToBoundingBox(BoundingBox.fromGeoPoints(focus).increaseByScale(1.3f), true)
                }
            }
        }
        m.invalidate()
    }
}
