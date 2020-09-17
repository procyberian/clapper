const { Gio, GLib, GObject, Gst, GstPlayer } = imports.gi;
const ByteArray = imports.byteArray;
const Debug = imports.clapper_src.debug;

const GSTPLAYER_DEFAULTS = {
    position_update_interval: 1000,
    seek_accurate: false,
    user_agent: 'clapper',
};

let { debug } = Debug;

var Player = GObject.registerClass(
class ClapperPlayer extends GstPlayer.Player
{
    _init(opts)
    {
        opts = opts || {};
        Object.assign(opts, GSTPLAYER_DEFAULTS);

        let gtkglsink = Gst.ElementFactory.make('gtkglsink', null);
        let glsinkbin = Gst.ElementFactory.make('glsinkbin', null);
        glsinkbin.sink = gtkglsink;

        let dispatcher = new GstPlayer.PlayerGMainContextSignalDispatcher();
        let renderer = new GstPlayer.PlayerVideoOverlayVideoRenderer({
            video_sink: glsinkbin
        });

        super._init({
            signal_dispatcher: dispatcher,
            video_renderer: renderer
        });

        // assign elements to player for later access
        // and make sure that GJS will not free them early
        this.gtkglsink = gtkglsink;
        this.glsinkbin = glsinkbin;
        this.dispatcher = dispatcher;
        this.renderer = renderer;

        this.gstRegistry = Gst.Registry.get();

        this._playerSignals = [];
        this._widgetSignals = [];

        let config = this.get_config();

        for(let setting of Object.keys(GSTPLAYER_DEFAULTS)) {
            let setOption = GstPlayer.Player[`config_set_${setting}`];
            if(!setOption) {
                debug(`unsupported option: ${setting}`, 'LEVEL_WARNING');
                continue;
            }
            setOption(config, opts[setting]);
        }

        this.set_config(config);
        this.set_mute(false);

        this.loop = GLib.MainLoop.new(null, false);
        this.run_loop = opts.run_loop || false;
        this.widget = gtkglsink.widget;
        this.state = GstPlayer.PlayerState.STOPPED;
        this.visualization_enabled = false;

        this._playlist = [];
        this._trackId = 0;
        this.playlist_ext = opts.playlist_ext || 'claps';

        this.connect('state-changed', this._onStateChanged.bind(this));
        this.connect('uri-loaded', this._onUriLoaded.bind(this));
        this.connect('end-of-stream', this._onStreamEnded.bind(this));
        this.connectWidget('destroy', this._onWidgetDestroy.bind(this));
    }

    set_media(source)
    {
        if(!Gst.uri_is_valid(source))
            source = Gst.filename_to_uri(source);

        if(!source)
            return debug('parsing source to URI failed');

        debug(`parsed source to URI: ${source}`);

        if(Gst.Uri.get_protocol(source) !== 'file')
            return this.set_uri(source);

        let file = Gio.file_new_for_uri(source);

        if(!file.query_exists(null)) {
            debug(`file does not exist: ${source}`, 'LEVEL_WARNING');
            this._trackId++;

            if(this._playlist.length <= this._trackId)
                return debug('set media reached end of playlist');

            return this.set_media(this._playlist[this._trackId]);
        }

        if(file.get_path().endsWith(`.${this.playlist_ext}`))
            return this.load_playlist_file(file);

        this.set_uri(source);
    }

    load_playlist_file(file)
    {
        let stream = new Gio.DataInputStream({
            base_stream: file.read(null)
        });
        let listdir = file.get_parent();
        let playlist = [];
        let line;

        while((line = stream.read_line(null)[0])) {
            line = (line instanceof Uint8Array)
                ? ByteArray.toString(line).trim()
                : String(line).trim();

            if(!Gst.uri_is_valid(line)) {
                let lineFile = listdir.resolve_relative_path(line);
                if(!lineFile)
                    continue;

                line = lineFile.get_path();
            }
            debug(`new playlist item: ${line}`);
            playlist.push(line);
        }
        stream.close(null);
        this.set_playlist(playlist);
    }

    set_playlist(playlist)
    {
        if(!Array.isArray(playlist) || !playlist.length)
            return;

        this._trackId = 0;
        this._playlist = playlist;

        this.set_media(this._playlist[0]);
    }

    get_playlist()
    {
        return this._playlist;
    }

    set_visualization_enabled(value)
    {
        if(value === this.visualization_enabled)
            return;

        super.set_visualization_enabled(value);
        this.visualization_enabled = value;
    }

    get_visualization_enabled()
    {
        return this.visualization_enabled;
    }

    seek_seconds(position)
    {
        this.seek(position * 1000000000);
    }

    toggle_play()
    {
        let action = (this.state === GstPlayer.PlayerState.PLAYING)
            ? 'pause'
            : 'play';

        this[action]();
    }

    set_subtitle_font_desc(desc)
    {
        let pipeline = this.get_pipeline();
        pipeline.subtitle_font_desc = desc;
    }

    set_codec_rank(codec, rank)
    {
        debug(`changing rank of codec: ${codec}`);

        let feature = this.gstRegistry.lookup_feature(codec);
        if(!feature)
            return debug(`codec unavailable: ${codec}`);

        let oldRank = feature.get_rank();
        feature.set_rank(rank);

        debug(`changed rank: ${oldRank} -> ${rank} for ${codec}`);
    }

    connect(signal, fn)
    {
        this._playerSignals.push(super.connect(signal, fn));
    }

    connectWidget(signal, fn)
    {
        this._widgetSignals.push(this.widget.connect(signal, fn));
    }

    _onStateChanged(player, state)
    {
        this.state = state;

        if(
            this.run_loop
            && this.state === GstPlayer.PlayerState.STOPPED
            && this.loop.is_running()
        )
            this.loop.quit();
    }

    _onStreamEnded(player)
    {
        this._trackId++;

        if(this._trackId < this._playlist.length)
            this.set_media(this._playlist[this._trackId]);
    }

    _onUriLoaded()
    {
        this.play();

        if(
            this.run_loop
            && !this.loop.is_running()
        )
            this.loop.run();
    }

    _onWidgetDestroy()
    {
        while(this._widgetSignals.length)
            this.widget.disconnect(this._widgetSignals.pop());

        while(this._playerSignals.length)
            this.disconnect(this._playerSignals.pop());

        if(this.state !== GstPlayer.PlayerState.STOPPED)
            this.stop();
    }
});
