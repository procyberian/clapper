const { Daemon } = imports.clapper_src.daemon;

function main()
{
    new Daemon(ARGV[0]);
}