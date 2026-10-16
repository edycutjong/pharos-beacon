// A local server that cannot start (tests only): it explains why on stderr and exits.
process.stderr.write("fake server: cannot open the RPC endpoint\n");
process.exit(1);
